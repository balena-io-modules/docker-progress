_ = require 'lodash'
Promise = require 'bluebird'
Docker = require 'docker-toolbelt'
ProgressReporter = require('./legacy').ProgressReporter

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

exports.DockerProgress = class DockerProgress
	constructor: (dockerOpts) ->
		if !(this instanceof DockerProgress)
			return new DockerProgress(dockerOpts)

		@docker = new Docker(dockerOpts)
		@reporter = new ProgressReporter(@getProgressRenderer(), @docker)

	getProgressRenderer: (stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT) ->
		return (percentage) ->
			renderProgress(percentage, stepCount)

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
		@reporter.pullProgress(image, onProgress)

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pushProgress: (image, onProgress) ->
		@reporter.pushProgress(image, onProgress)
