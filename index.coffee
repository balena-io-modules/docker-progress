_ = require 'lodash'
semver = require 'semver'
Promise = require 'bluebird'
Docker = require 'docker-toolbelt'

legacy = require './legacy'

# These are deprecated and will be removed on 3.0
exports.RegistryV1 = legacy.RegistryV1
exports.RegistryV2 = legacy.RegistryV2

LEGACY_DOCKER_VERSION = '1.10.0'
DEFAULT_PROGRESS_BAR_STEP_COUNT = 50

tryExtractDigestHash = (evt) ->
	if evt.aux? and evt.aux.Digest?
		return evt.aux.Digest
	if _.isString(evt.status)
		matchPull = evt.status.match(/^Digest:\s([a-zA-Z0-9]+:[a-f0-9]+)$/)
		return matchPull[1] if matchPull?

# Extracts the digest value of an image from docker events
# for push and pull operations, if no digest value is found
# null is returned
extractDigestHash = (stream) ->
	# iterator over the event stream in reverse order
	# the digest event is one of the last ones.
	for idx in [stream.length - 1..0] by -1
		hash = tryExtractDigestHash(stream[idx])
		return hash if hash?
	return null

isBalaena = (versionInfo) ->
	versionInfo['Engine'] in [ 'balena', 'balaena' ]

# Builds and returns a Docker-like progress bar like this:
# [==================================>               ] 64%
renderProgress = (percentage, stepCount) ->
	percentage = _.clamp(percentage, 0, 100)
	barCount = stepCount * percentage // 100
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

	linkLayer: (id, tracker) ->
		@layers[id] = tracker.layers[id]

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
		avgProgress = _.meanBy(layers, 'progress') || 0
		return Math.round(100 * avgProgress)

	patchProgressEvent: (progress) ->
		# some events arrive without .total
		progress.total ?= progress.current
		# some events arrive with .current > .total
		progress.current = Math.min(progress.current, progress.total)

class ProgressReporter
	constructor: (@renderProgress) -> #

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pullProgress: Promise.method (image, onProgress) ->
		progressRenderer = @renderProgress
		downloadProgressTracker = new ProgressTracker(100 * 1024) # 100 KB
		extractionProgressTracker = new ProgressTracker(1024 * 1024) # 1 MB
		lastPercentage = 0
		return (evt) ->
			try
				{ id, status } = evt

				if status is 'Pulling fs layer'
					downloadProgressTracker.addLayer(id)
					extractionProgressTracker.addLayer(id)
				else if status is 'Ready to download'
					# resin-os/docker extracts layers as they're downloaded and omits
					# download stage events completely, only emitting extraction events.
					# We determine this is the case from the 'Ready to download' event
					# emitted once for each layer by resin-os/docker at the start of the
					# pull. We then create a "link" of the progress record for the layer
					# between the download and extraction progress trackers by sharing
					# the record "pointer", so that later events affect progress in both
					# trackers. This simplifies handling this case a lot, because it
					# allows us to continue to assume there's always two stages in pull.
					downloadProgressTracker.linkLayer(id, extractionProgressTracker)
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

				if status.startsWith('Status: Image is up to date for ') or status.startsWith('Status: Downloaded newer image for ')
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
	pushProgress: Promise.method (image, onProgress) ->
		progressRenderer = @renderProgress
		progressTracker = new ProgressTracker(100 * 1024) # 100 KB
		lastPercentage = 0
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

				percentage = if status.search(/.+: digest: /) == 0 or status.startsWith('Pushing tag for rev ')
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

class BalaenaProgressReporter extends ProgressReporter
	pullProgress: Promise.method (image, onProgress) ->
		progressRenderer = @renderProgress
		lastPercentage = 0
		return (evt) ->
			try
				{ id } = evt

				if id isnt 'Total'
					return

				{ current, total } = evt.progressDetail
				percentage = current * 100 // total
				percentage = lastPercentage = Math.max(percentage, lastPercentage)

				onProgress _.merge evt, {
					percentage
					downloadedPercentage: current
					extractedPercentage: current
					totalProgress: progressRenderer(percentage)
				}
			catch err
				console.warn('Progress error:', err.message ? err)

exports.DockerProgress = class DockerProgress
	constructor: (opts = {}) ->
		if !(this instanceof DockerProgress)
			return new DockerProgress(opts)
		if opts.dockerToolbelt?
			if !_.isFunction(opts.dockerToolbelt.getRegistryAndName) or !opts.dockerToolbelt.modem?.Promise?
				throw new Error('Invalid dockerToolbelt option, please use an instance of docker-toolbelt v3.0.1 or higher')
			@docker = opts.dockerToolbelt
		else
			@docker = new Docker(opts)
		@reporter = null

	getProgressRenderer: (stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT) ->
		return (percentage) ->
			renderProgress(percentage, stepCount)

	getProgressReporter: ->
		return @reporter if @reporter?
		docker = @docker
		renderer = @getProgressRenderer()
		@reporter = docker.version().then (res) ->
			version = res['Version']
			if isBalaena(res)
				return new BalaenaProgressReporter(renderer)
			else if semver.valid(version) and semver.lt(version, LEGACY_DOCKER_VERSION)
				return new legacy.ProgressReporter(renderer, docker)
			else
				return new ProgressReporter(renderer)

	aggregateProgress: (count, onProgress) ->
		renderer = @getProgressRenderer()
		states = _.times(count, -> percentage: 0)
		return _.times count, (index) ->
			return (evt) ->
				# update current reporter state
				states[index].percentage = evt.percentage
				# update totals
				percentage = _.sumBy(states, 'percentage') // (states.length || 1)
				# update event
				evt.totalProgress = renderer(percentage)
				evt.percentage = percentage
				evt.progressIndex = index
				# call callback with aggregate event
				onProgress(evt)

	# Pull docker image calling onProgress with extended progress info regularly
	pull: (image, onProgress, options, callback) ->
		if typeof options is 'function'
			callback = options
			options = null

		onProgressPromise = @pullProgress(image, onProgress)
		onProgress = onProgressHandler(onProgressPromise, onProgress)
		@docker.pull(image, options)
		.then (stream) =>
			Promise.fromCallback (callback) =>
				@docker.modem.followProgress(stream, callback, onProgress)
		.then extractDigestHash
		.nodeify(callback)

	# Push docker image calling onProgress with extended progress info regularly
	push: (image, onProgress, options, callback) ->
		onProgressPromise = @pushProgress(image, onProgress)
		onProgress = onProgressHandler(onProgressPromise, onProgress)
		@docker.getImage(image).push(options)
		.then (stream) =>
			Promise.fromCallback (callback) =>
				@docker.modem.followProgress(stream, callback, onProgress)
		.then extractDigestHash
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

	# The following are deprecated and will be removed on 3.0

	getRegistryAndName: (image) ->
		legacy.getRegistryAndName(@docker, image)

	# Get download size of the layers of an image.
	# The object returned has layer ids as keys and their download size as values.
	# Download size is the size that docker will download if the image will be pulled now.
	# If some layer is already downloaded, it will return 0 size for that layer.
	getLayerDownloadSizes: (image) ->
		legacy.getLayerDownloadSizes(@docker, image)

	# Get size of all layers of a local image
	# "image" is a string, the name of the docker image
	getImageLayerSizes: (image) ->
		legacy.getImageLayerSizes(@docker, image)
