_ = require 'lodash'
Promise = require 'bluebird'
Docker = require 'docker-toolbelt'
request = require 'request'

request = request.defaults(
	gzip: true
	timeout: 30000
)
request = Promise.promisifyAll(request, multiArgs: true)

class Registry
	constructor: (registry, @version) ->
		match = registry.match(/^([^\/:]+)(?::([^\/]+))?$/)
		if not match
			throw new Error("Could not parse the registry: #{registry}")

		[ ..., @registry, port = 443 ] = match
		@port = _.parseInt(port)
		if _.isNaN(@port)
			throw new TypeError("Port must be a valid integer, got '#{port}'")

		@protocol = if @port is 443 then 'https' else 'http'

	get: (path) ->
		request.getAsync("#{@protocol}://#{@registry}:#{@port}#{path}")

	# Convert to string in the format registry.tld:port
	toString: ->
		return "#{@registry}:#{@port}"

exports.RegistryV1 = class RegistryV1 extends Registry
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

	getLayerDownloadSizes: (imageName, tagName) ->
		layerSizes = {}
		layerIds = []
		@getImageId(imageName, tagName)
		.then (imageId) =>
			@getImageHistory(imageId)
		.map (layerId) =>
			layerIds.push(layerId)
			@getImageDownloadSize(layerId)
			.then (size) ->
				layerSizes[layerId] = size
		.return([ layerSizes, layerIds ])

exports.RegistryV2 = class RegistryV2 extends Registry
	# Return the ids of the layers of an image.
	getImageLayers: (imageName, tagName) ->
		@get("/v2/#{imageName}/manifests/#{tagName}")
		.spread (res, data) =>
			if res.statusCode >= 400
				throw new Error("Failed to get image ancestry of #{imageName} from #{@registry}. Status code: #{res.statusCode}")
			_.map(JSON.parse(data).fsLayers, 'blobSum')

	# Return the number of bytes docker has to download to pull this blob.
	getLayerDownloadSize: (imageName, blobId) ->
		@get("/v2/#{imageName}/blobs/#{blobId}")
		.spread (res, data) =>
			if res.statusCode >= 400
				throw new Error("Failed to get image download size of #{imageName} from #{@registry}. Status code: #{res.statusCode}")
			return parseInt(res.headers['content-length'])

	# Gives download size per layer (blob)
	getLayerDownloadSizes: (imageName, tagName) ->
		layerSizes = {}
		layerIds = []
		@getImageLayers(imageName, tagName)
		.map (blobId) =>
			layerIds.unshift(blobId)
			@getLayerDownloadSize(imageName, blobId)
			.then (size) ->
				layerSizes[blobId] = size
		.return([ layerSizes, layerIds ])

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

	getRegistryAndName: (image) ->
		@docker.getRegistryAndName(image)
		.then ({ registry, imageName, tagName }) ->
			request.getAsync("https://#{registry}/v2")
			.get(0)
			.then (res) ->
				if res.statusCode == 404 # assume v1 if not v2
					registry = new RegistryV1(registry)
				else
					registry = new RegistryV2(registry)
				return { registry, imageName, tagName }

	# Get download size of the layers of an image.
	# The object returned has layer ids as keys and their download size as values.
	# Download size is the size that docker will download if the image will be pulled now.
	# If some layer is already downloaded, it will return 0 size for that layer.
	getLayerDownloadSizes: (image) ->
		@getRegistryAndName(image)
		.then ({ registry, imageName, tagName }) ->
			registry.getLayerDownloadSizes(imageName, tagName)

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pullProgress: (image, onProgress) ->
		@getLayerDownloadSizes(image)
		.spread (layerSizes, remoteLayerIds) ->
			layerIds = {} # map from remote to local ids
			totalSize = _.sum(_.values(layerSizes))
			completedSize = 0
			currentDownloadedSize = {}
			return (evt) ->
				try
					{ status } = evt
					shortId = evt.id
					if evt.progressDetail? and not layerIds[shortId]?
						remoteId = remoteLayerIds.find (id) ->
							id.replace(/^sha256:/, '').startsWith(shortId)
						if not remoteId?
							remoteId = remoteLayerIds[_.size(layerIds)]
						layerIds[shortId] = remoteId
					if status is 'Downloading'
						currentDownloadedSize[shortId] = evt.progressDetail.current
					else if status is 'Download complete' or status is 'Already exists'
						remoteId = layerIds[shortId]
						completedSize += layerSizes[remoteId]
						currentDownloadedSize[shortId] = 0
					else if status.match(/^Status: Image is up to date for /)
						completedSize = totalSize
						currentDownloadedSize = {}

					downloadedSize = completedSize + _.sum(_.values(currentDownloadedSize))
					percentage = calculatePercentage(downloadedSize, totalSize)

					onProgress(_.merge(evt, { downloadedSize, totalSize, percentage }))
				catch err
					console.warn('Progress error:', err.message ? err)
					totalSize = null

	# Get size of all layers of a local image
	# "image" is a string, the name of the docker image
	getImageLayerSizes: (image) ->
		image = @docker.getImage(image)
		layers = image.historyAsync()
		lastLayer = image.inspectAsync()
		Promise.join layers, lastLayer, (layers, lastLayer) ->
			layers.push(lastLayer)
			_(layers)
			.keyBy('Id')
			.mapValues('Size')
			.mapKeys (v, id) ->
				id.replace(/^sha256:/, '')
			.value()

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pushProgress: (image, onProgress) ->
		@getImageLayerSizes(image)
		.then (layerSizes) ->
			layerIds = _.keys(layerSizes)
			layerPushedSize = {}
			completedSize = 0
			totalSize = _.sum(_.values(layerSizes))
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
					pushedSize = completedSize + _.sum(_.values(layerPushedSize))
					percentage = calculatePercentage(pushedSize, totalSize)
					onProgress(_.merge(evt, { pushedSize, totalSize, percentage }))
				catch err
					console.warn('Progress error:', err.message ? err)
					totalSize = null
