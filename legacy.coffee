# These are deprecated and will be removed on 3.0

_ = require 'lodash'
Promise = require 'bluebird'
request = require 'request'

request = request.defaults(
	gzip: true
	timeout: 30000
)
request = Promise.promisifyAll(request, multiArgs: true)

exports.getRegistryAndName = getRegistryAndName = (docker, image) ->
	docker.getRegistryAndName(image)
	.then ({ registry, imageName, tagName }) ->
		request.getAsync("https://#{registry}/v2")
		.get(0)
		.then (res) ->
			if res.statusCode == 404 # assume v1 if not v2
				registry = new RegistryV1(registry)
			else
				registry = new RegistryV2(registry)
			return { registry, imageName, tagName }

exports.getLayerDownloadSizes = (docker, image) ->
	getRegistryAndName(docker, image)
	.then ({ registry, imageName, tagName }) ->
		registry.getLayerDownloadSizes(imageName, tagName)

exports.getImageLayerSizes = (docker, image) ->
	image = docker.getImage(image)
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

	head: (path) ->
		request.headAsync("#{@protocol}://#{@registry}:#{@port}#{path}")

	# Convert to string in the format registry.tld:port
	toString: ->
		return "#{@registry}:#{@port}"

exports.RegistryV1 = class RegistryV1 extends Registry
	constructor: (registry) ->
		super(registry, 1)

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
		@getImageId(imageName, tagName)
		.then (imageId) =>
			@getImageHistory(imageId)
		.then (layerIds) =>
			layerSizes = {}
			Promise.map layerIds, (layerId) =>
				@getImageDownloadSize(layerId)
				.then (size) ->
					layerSizes[layerId] = size
			.return([ layerSizes, layerIds ])

exports.RegistryV2 = class RegistryV2 extends Registry
	constructor: (registry) ->
		super(registry, 2)

	# Return the ids of the layers of an image.
	getImageLayers: (imageName, tagName) ->
		@get("/v2/#{imageName}/manifests/#{tagName}")
		.spread (res, data) =>
			if res.statusCode >= 400
				throw new Error("Failed to get image ancestry of #{imageName} from #{@registry}. Status code: #{res.statusCode}")
			_.map(JSON.parse(data).fsLayers, 'blobSum')

	# Return the number of bytes docker has to download to pull this blob.
	getLayerDownloadSize: (imageName, blobId) ->
		@head("/v2/#{imageName}/blobs/#{blobId}")
		.spread (res, data) =>
			if res.statusCode >= 400
				throw new Error("Failed to get image download size of #{imageName} from #{@registry}. Status code: #{res.statusCode}")
			return parseInt(res.headers['content-length'])

	# Gives download size per layer (blob)
	getLayerDownloadSizes: (imageName, tagName) ->
		@getImageLayers(imageName, tagName)
		.then (blobIds) =>
			layerSizes = {}
			Promise.map blobIds, (blobId) =>
				@getLayerDownloadSize(imageName, blobId)
				.then (size) ->
					layerSizes[blobId] = size
			.return([ layerSizes, blobIds.reverse() ])

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

getLongId = (shortId, layerIds) ->
	if not shortId?
		throw new Error('Progress event missing layer id. Progress not correct.')
	longId = _.find(layerIds, (id) -> _.startsWith(id, shortId))
	if not longId?
		throw new Error("Progress error: Unknown layer #{shortId} referenced by docker. Progress not correct.")
	return longId

exports.ProgressReporter = class ProgressReporter
	constructor: (@renderProgress, @docker) -> #

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
			.spread (layerSizes, remoteLayerIds) ->
				[ registry.getVersion(), layerSizes, remoteLayerIds ]

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pullProgress: (image, onProgress) ->
		progressRenderer = @renderProgress
		@getLayerDownloadSizes(image)
		.spread (registryVersion, layerSizes, remoteLayerIds) ->
			layerIds = {} # map from remote to local ids
			progressMultiplier = 2
			totalSize = _.sum(_.values(layerSizes))
			totalDownloadedSize = 0
			totalExtractedSize = 0
			currentDownloadedSize = {}
			currentExtractedSize = {}
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
					else if status is 'Extracting'
						currentExtractedSize[shortId] = evt.progressDetail.current
					else if status is 'Download complete'
						remoteId = layerIds[shortId]
						totalDownloadedSize += layerSizes[remoteId]
						currentDownloadedSize[shortId] = 0
					else if status is 'Pull complete'
						remoteId = layerIds[shortId]
						totalExtractedSize += layerSizes[remoteId]
						currentExtractedSize[shortId] = 0
					else if status is 'Already exists'
						remoteId = layerIds[shortId]
						totalDownloadedSize += layerSizes[remoteId]
						totalExtractedSize += layerSizes[remoteId]
						currentDownloadedSize[shortId] = 0
						currentExtractedSize[shortId] = 0
					else if status.startsWith('Status: Image is up to date for ') or status.startsWith('Status: Downloaded newer image for ')
						totalDownloadedSize = totalSize
						totalExtractedSize = totalSize
						currentDownloadedSize = {}
						currentExtractedSize = {}

					# when pulling from registry v1, docker doesn't report extraction
					# events. reset here so that we don't skew progress calculation.
					if registryVersion < 2
						progressMultiplier = 1
						totalExtractedSize = 0
						currentExtractedSize = {}

					downloadedSize = totalDownloadedSize + _.sum(_.values(currentDownloadedSize))
					downloadedPercentage = calculatePercentage(downloadedSize, totalSize)

					extractedSize = totalExtractedSize + _.sum(_.values(currentExtractedSize))
					extractedPercentage = calculatePercentage(extractedSize, totalSize)

					percentage = (downloadedPercentage + extractedPercentage) // progressMultiplier

					onProgress _.merge evt, {
						percentage
						downloadedSize
						extractedSize
						totalSize: totalSize * progressMultiplier
						totalProgress: progressRenderer(percentage)
					}
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
		progressRenderer = @renderProgress
		@getImageLayerSizes(image)
		.then (layerSizes) ->
			layerIds = _.keys(layerSizes)
			layerPushedSize = {}
			completedSize = 0
			totalSize = _.sum(_.values(layerSizes))
			completeStatuses = [
				'Image already exists'
				'Layer already exists'
				'Image successfully pushed'
			]
			return (evt) ->
				try
					{ status } = evt
					shortId = evt.id
					pushMatch = /Image (.*) already pushed/.exec(status)
					if status is 'Pushing' and evt.progressDetail.current?
						longId = getLongId(shortId, layerIds)
						if longId?
							layerPushedSize[longId] = evt.progressDetail.current
					else if pushMatch or _.includes(completeStatuses, status)
						shortId or= pushMatch[1]
						longId = getLongId(shortId, layerIds)
						if longId?
							completedSize += layerSizes[longId]
							layerPushedSize[longId] = 0

					if status.startsWith('latest: digest: ') or status.startsWith('Pushing tag for rev ')
						pushedSize = totalSize
						percentage = 100
					else
						pushedSize = completedSize + _.sum(_.values(layerPushedSize))
						percentage = calculatePercentage(pushedSize, totalSize)

					onProgress _.merge evt, {
						percentage
						pushedSize
						totalSize
						totalProgress: progressRenderer(percentage)
					}
				catch err
					console.warn('Progress error:', err.message ? err)
					totalSize = null
