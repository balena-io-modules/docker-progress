_ = require 'lodash'
Promise = require 'bluebird'
Docker = require 'dockerode'
request = require 'request'

request = request.defaults(
	gzip: true
	timeout: 30000
)
request = Promise.promisifyAll(request)

Promise.promisifyAll(Docker.prototype)
# Hack dockerode to promisify internal classes' prototypes
Promise.promisifyAll(Docker({}).getImage().constructor.prototype)
Promise.promisifyAll(Docker({}).getContainer().constructor.prototype)

exports.Registry = class Registry
	constructor: (registry) ->
		match = registry.match(/^([^\/:]+)(?::([^\/]+))?$/)
		if not match
			throw new Error("Could not parse the registry: #{registry}")

		[ m, @registry, port = 443 ] = match
		@port = _.parseInt(port)
		if _.isNaN(@port)
			throw new TypeError("Port must be a valid integer, got '#{port}'")

		@protocol = if @port is 443 then 'https' else 'http'

	get: (path) ->
		request.getAsync("#{@protocol}://#{@registry}:#{@port}#{path}")

	# Get the id of an image on a given registry and tag.
	getImageId: (imageName, tagName) ->
		@get("/v1/repositories/#{imageName}/tags")
		.spread (res, data) =>
			if res.statusCode == 404
				throw new Error("No such image #{imageName} on registry #{@registry}")
			if res.statusCode >= 400
				throw new Error("Failed to get image tags of #{imageName} from #{@registry}. Status code: #{res.statusCode}")
			tags = JSON.parse(data)
			if !tags[tagName]?
				throw new Error("Could not find tag #{tagName} for image #{imageName}")
			return tags[tagName]

	# Return the ids of the layers of an image.
	getImageHistory: (imageId) ->
		@get("/v1/images/#{imageId}/ancestry")
		.spread (res, data) =>
			if res.statusCode >= 400
				throw new Error("Failed to get image ancestry of #{imageId} from #{@registry}. Status code: #{res.statusCode}")
			history = JSON.parse(data)
			return history

	# Return the number of bytes docker has to download to pull this image (or layer).
	getImageDownloadSize: (imageId) ->
		@get("/v1/images/#{imageId}/json")
		.spread (res, data) =>
			if res.statusCode >= 400
				throw new Error("Failed to get image download size of #{imageId} from #{@registry}. Status code: #{res.statusCode}")
			return parseInt(res.headers['x-docker-size'])

	# Convert to string in the format registry.tld:port
	toString: ->
		return "#{@registry}:#{@port}"

# Return percentage from current completed/total, handling edge cases.
# Null total is considered an unknown total and 0 percentage is returned.
calculatePercentage = (completed, total) ->
	if not total?
		percentage = 0 # report 0% if unknown total size
	else if total is 0
		percentage = 100 # report 100% if 0 total size
	else
		percentage = Math.min(100, (100 * completed) // total)
	return percentage

onProgressHandler = (onProgressPromise, fallbackOnProgress) ->
	evts = []
	onProgress = (evt) ->
		evts.push(evt)
	# Once the onProgressPromise is fulfilled we switch `onProgress` to the real callback,
	# or the fallback if it fails, and then call it with all the previously received events in order
	onProgressPromise
	.then (resolvedOnProgress) ->
		onProgress = resolvedOnProgress
	.catch (realOnProgress) ->
		onProgress = fallbackOnProgress
	.then ->
		_.map evts, (evt) ->
			try
				onProgress(evt)
	# Return an indirect call to `onProgress` so that we can switch to the
	# real onProgress function when the promise resolves
	return (evt) -> onProgress(evt)

getLongId = (shortId, layerIds) ->
	if not shortId?
		throw new Error('Progress event missing layer id. Progress not correct.')
	longId = _.find(layerIds, (id) -> _.startsWith(id, shortId))
	if not longId?
		throw new Error("Progress error: Unknown layer #{shortId} referenced by docker. Progress not correct.")
	return longId

exports.DockerProgress = class DockerProgress
	constructor: (dockerOpts) ->
		if !(this instanceof DockerProgress)
			return new DockerProgress(dockerOpts)

		@docker = new Docker(dockerOpts)

	# Pull docker image calling onProgress with extended progress info regularly
	pull: (image, onProgress, callback) ->
		onProgressPromise = @pullProgress(image, onProgress)
		onProgress = onProgressHandler(onProgressPromise, onProgress)
		@docker.pullAsync(image)
		.then (stream) =>
			Promise.fromNode (callback) =>
				@docker.modem.followProgress(stream, callback, onProgress)
		.nodeify(callback)


	# Push docker image calling onProgress with extended progress info regularly
	push: (image, onProgress, options, callback) ->
		onProgressPromise = @pushProgress(image, onProgress)
		onProgress = onProgressHandler(onProgressPromise, onProgress)
		@docker.getImage(image).pushAsync(options)
		.then (stream) =>
			Promise.fromNode (callback) =>
				@docker.modem.followProgress(stream, callback, onProgress)
		.nodeify(callback)


	# Return true if an image exists in the local docker repository, false otherwise.
	imageExists: (imageId) ->
		@docker.getImage(imageId).inspectAsync()
		.return true
		.catch ->
			return false

	# Get download size of the layers of an image.
	# The object returned has layer ids as keys and their download size as values.
	# Download size is the size that docker will download if the image will be pulled now.
	# If some layer is already downloaded, it will return 0 size for that layer.
	getLayerDownloadSizes: (image) ->
		getRegistryAndName(image)
		.then ({ registry,  imageName, tagName }) =>
			imageSizes = {}
			registry.getImageId(imageName, tagName)
			.then (imageId) ->
				registry.getImageHistory(imageId)
			.map (layerId) =>
				@imageExists(layerId)
				.then (exists) ->
					if exists
						return 0
					registry.getImageDownloadSize(layerId)
				.then (size) ->
					imageSizes[layerId] = size
			.return imageSizes

	# Get size of all layers of a local image
	# "image" is a string, the name of the docker image
	getImageLayerSizes: (image) ->
		image = @docker.getImage(image)
		layers = image.historyAsync()
		lastLayer = image.inspectAsync()
		Promise.join layers, lastLayer, (layers, lastLayer) ->
			layers.push(lastLayer)
			_(layers)
			.indexBy('Id')
			.mapValues('Size')
			.mapKeys (v, id) ->
				id.replace(/^sha256:/, '')
			.value()

	# Create a stream that transforms `docker.modem.followProgress` onProgress events to include total progress metrics.
	pullProgress: (image, onProgress) ->
		@getLayerDownloadSizes(image)
		.then (layerSizes) ->
			layerIds = _.keys(layerSizes)
			completedSize = 0
			layerDownloadedSize = {}
			totalSize = _.sum(layerSizes)
			return (evt) ->
				try
					{ status } = evt
					shortId = evt.id
					if status is 'Downloading'
						longId = getLongId(shortId, layerIds)
						layerDownloadedSize[longId] = evt.progressDetail.current
					else if status is 'Download complete' or status is 'Already exists'
						longId = getLongId(shortId, layerIds)
						completedSize += layerSizes[longId]
						layerDownloadedSize[longId] = 0
						layerSizes[longId] = 0 # make sure we don't count this layer again
					downloadedSize = completedSize + _.sum(layerDownloadedSize)
					percentage = calculatePercentage(downloadedSize, totalSize)

					onProgress(_.merge(evt, { downloadedSize, totalSize, percentage }))
				catch err
					console.warn('Progress error:', err.message ? err)
					totalSize = null

	# Create a stream that transforms `docker.modem.followProgress` onProgress events to include total progress metrics.
	pushProgress: (image, onProgress) ->
		@getImageLayerSizes(image)
		.then (layerSizes) ->
			layerIds = _.keys(layerSizes)
			layerPushedSize = {}
			completedSize = 0
			totalSize = _.sum(layerSizes)
			return (evt) ->
				try
					{ status } = evt
					shortId = evt.id
					pushMatch = /Image (.*) already pushed/.exec(status)
					if status is 'Pushing' and evt.progressDetail.current?
						longId = getLongId(shortId, layerIds)
						if longId?
							layerPushedSize[longId] = evt.progressDetail.current
					else if status is 'Layer already exists' or status is 'Image successfully pushed' or pushMatch
						shortId or= pushMatch[1]
						longId = getLongId(shortId, layerIds)
						if longId?
							completedSize += layerSizes[longId]
							layerPushedSize[longId] = 0
					pushedSize = completedSize + _.sum(layerPushedSize)
					percentage = calculatePercentage(pushedSize, totalSize)
					onProgress(_.merge(evt, { pushedSize, totalSize, percentage }))
				catch err
					console.warn('Progress error:', err.message ? err)
					totalSize = null

# Separate string containing registry and image name into its parts.
# Example: registry.resinstaging.io/resin/rpi
#          { registry: "registry.resinstaging.io", imageName: "resin/rpi" }
exports.getRegistryAndName = getRegistryAndName = Promise.method (image) ->
	match = image.match(/^(?:([^\/:]+(?::[^\/]+)?)\/)?([^\/:]+(?:\/[^\/:]+)?)(?::(.*))?$/)
	if not match
		throw new Error("Could not parse the image: #{image}")
	[ m, registry = 'docker.io', imageName, tagName = 'latest' ] = match
	if not imageName
		throw new Error('Invalid image name, expected domain.tld/repo/image format.')
	registry = new Registry(registry)
	return { registry, imageName, tagName }
