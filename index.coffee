_ = require 'lodash'
semver = require 'semver'
Promise = require 'bluebird'
Docker = require 'docker-toolbelt'

LEGACY_DOCKER_VERSION = '1.10.0'
DEFAULT_PROGRESS_BAR_STEP_COUNT = 50

# Builds and returns a Docker-like progress bar like this:
# [==================================>               ] 64%
renderProgress = (percentage, stepCount) ->
	percentage = Math.min(Math.max(percentage, 0), 100)
	barCount =  stepCount * percentage // 100
	spaceCount = stepCount - barCount
	bar = "[#{_.repeat('=', barCount)}>#{_.repeat(' ', spaceCount)}]"
	return "#{bar} #{percentage}%"

onProgressHandler = (onProgressPromise, fallbackOnProgress) ->
	evts = []
	onProgress = (evt) ->
		evts.push(evt)
	# Once the onProgressPromise is fulfilled we switch `onProgress` to the real callback,
	# or the fallback if it fails, and then call it with all the previously received events in order
	onProgressPromise
	.then (resolvedOnProgress) ->
		onProgress = resolvedOnProgress
	.catch (e) ->
		console.warn('error', e)
		onProgress = fallbackOnProgress
	.then ->
		_.map evts, (evt) ->
			try
				onProgress(evt)
	# Return an indirect call to `onProgress` so that we can switch to the
	# real onProgress function when the promise resolves
	return (evt) -> onProgress(evt)

class ProgressTracker
	constructor: (@coalesceBelow = 0) ->
		@layers = {}

	addLayer: (id) ->
		@layers[id] = { progress: null, coalesced: false }

	updateLayer: (id, progress) ->
		return if not id?
		@addLayer(id) if not @layers[id]
		@patchProgressEvent(progress)
		@layers[id].coalesced = not @layers[id].progress? and progress.total < @coalesceBelow
		@layers[id].progress = (progress.current / progress.total) || 0 # prevent NaN when .total = 0

	finishLayer: (id) ->
		@updateLayer(id, { current: 1, total: 1 })

	getProgress: ->
		layers = _.filter(@layers, coalesced: false)
		layerCount = layers.length || 1
		progress = _.sumBy(layers, 'progress')
		return Math.round(100 * progress / layerCount)

	patchProgressEvent: (progress) ->
		# some events arrive without .total
		progress.total ?= progress.current
		# some events arrive with .current > .total
		progress.current = Math.min(progress.current, progress.total)

class ProgressReporter
	constructor: (@renderProgress) -> #

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pullProgress: (image, onProgress) ->
		progressRenderer = @renderProgress
		downloadProgressTracker = new ProgressTracker(100 * 1024) # 100 KB
		extractionProgressTracker = new ProgressTracker(1024 * 1024) # 1 MB
		lastPercentage = 0
		Promise.try ->
			return (evt) ->
				try
					{ id, status } = evt

					if status is 'Pulling fs layer'
						downloadProgressTracker.addLayer(id)
						extractionProgressTracker.addLayer(id)
					else if status is 'Downloading'
						downloadProgressTracker.updateLayer(id, evt.progressDetail)
					else if status is 'Extracting'
						extractionProgressTracker.updateLayer(id, evt.progressDetail)
					else if status is 'Download complete'
						downloadProgressTracker.finishLayer(id)
					else if status is 'Pull complete'
						extractionProgressTracker.finishLayer(id)
					else if status is 'Already exists'
						downloadProgressTracker.finishLayer(id)
						extractionProgressTracker.finishLayer(id)

					if status.match(/^Status: Image is up to date for /) or status.match(/^Status: Downloaded newer image for /)
						downloadedPercentage = 100
						extractedPercentage = 100
					else
						downloadedPercentage = downloadProgressTracker.getProgress()
						extractedPercentage = extractionProgressTracker.getProgress()

					percentage = (downloadedPercentage + extractedPercentage) // 2
					percentage = lastPercentage = Math.max(percentage, lastPercentage)

					onProgress _.merge evt, {
						percentage
						downloadedPercentage
						extractedPercentage
						totalProgress: progressRenderer(percentage)
					}
				catch err
					console.warn('Progress error:', err.message ? err)

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pushProgress: (image, onProgress) ->
		progressRenderer = @renderProgress
		progressTracker = new ProgressTracker(100 * 1024) # 100 KB
		lastPercentage = 0
		Promise.try ->
			return (evt) ->
				try
					{ id, status } = evt

					pushMatch = /Image (.*) already pushed/.exec(status)

					id ?= pushMatch?[1]
					status ?= ''

					if status is 'Preparing'
						progressTracker.addLayer(id)
					else if status is 'Pushing' and evt.progressDetail.current?
						progressTracker.updateLayer(id, evt.progressDetail)
					# registry v2 statuses
					else if _.includes(['Pushed', 'Layer already exists', 'Image already exists'], status) or /^Mounted from /.test(status)
						progressTracker.finishLayer(id)
					# registry v1 statuses
					else if pushMatch? or _.includes(['Already exists', 'Image successfully pushed'], status)
						progressTracker.finishLayer(id)

					percentage = if status.match(/^latest: digest: /) or status.match(/^Pushing tag for rev /)
						100
					else
						progressTracker.getProgress()

					percentage = lastPercentage = Math.max(percentage, lastPercentage)

					onProgress _.merge evt, {
						id
						percentage
						totalProgress: progressRenderer(percentage)
					}
				catch err
					console.warn('Progress error:', err.message ? err)

exports.DockerProgress = class DockerProgress
	constructor: (dockerOpts) ->
		if !(this instanceof DockerProgress)
			return new DockerProgress(dockerOpts)

		@docker = new Docker(dockerOpts)
		@reporter = null

	getProgressRenderer: (stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT) ->
		return (percentage) ->
			renderProgress(percentage, stepCount)

	getProgressReporter: ->
		return @reporter if @reporter?
		docker = @docker
		renderer = @getProgressRenderer()
		@reporter = docker.versionAsync().then (res) ->
			version = res['Version']
			if version? and semver.lt(version, LEGACY_DOCKER_VERSION)
				LegacyProgressReporter = require('./legacy').ProgressReporter
				return new LegacyProgressReporter(renderer, docker)
			else
				return new ProgressReporter(renderer)

	# Pull docker image calling onProgress with extended progress info regularly
	pull: (image, onProgress, callback) ->
		onProgressPromise = @pullProgress(image, onProgress)
		onProgress = onProgressHandler(onProgressPromise, onProgress)
		@docker.pullAsync(image)
		.then (stream) =>
			Promise.fromCallback (callback) =>
				@docker.modem.followProgress(stream, callback, onProgress)
		.nodeify(callback)

	# Push docker image calling onProgress with extended progress info regularly
	push: (image, onProgress, options, callback) ->
		onProgressPromise = @pushProgress(image, onProgress)
		onProgress = onProgressHandler(onProgressPromise, onProgress)
		@docker.getImage(image).pushAsync(options)
		.then (stream) =>
			Promise.fromCallback (callback) =>
				@docker.modem.followProgress(stream, callback, onProgress)
		.nodeify(callback)

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pullProgress: (image, onProgress) ->
		@getProgressReporter().then (reporter) ->
			reporter.pullProgress(image, onProgress)

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pushProgress: (image, onProgress) ->
		@getProgressReporter().then (reporter) ->
			reporter.pushProgress(image, onProgress)
