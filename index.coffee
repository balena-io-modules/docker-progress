_ = require 'lodash'
Promise = require 'bluebird'
Docker = require 'docker-toolbelt'
request = require 'request'
humanize = require 'humanize'

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

stripShaPrefix = (id) ->
	id?.replace(/^sha256:/, '')

minmax = (value, min, max) ->
	Math.min(Math.max(value, min), max)

remapShortId = (shortId, remoteLayerIds, knownLayerIds) ->
	remoteId = remoteLayerIds.find (id) ->
		stripShaPrefix(id).startsWith(shortId)
	if not remoteId?
		remoteId = remoteLayerIds[_.size(knownLayerIds)]
	knownLayerIds[shortId] = remoteId

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

DEFAULT_PROGRESS_BAR_STEP_COUNT = 50

# Builds and returns a Docker-like progress bar like this:
# [==================================>               ] XXX.XX MB/178.83 MB - 64%
renderProgress = (percentage, completed, total, stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT) ->
	barCount =  stepCount * percentage // 100
	spaceCount = stepCount - barCount
	bar = "[#{_.repeat('=', barCount)}>#{_.repeat(' ', spaceCount)}]"
	stats = "#{humanize.filesize(completed)}/#{humanize.filesize(total)} - #{percentage}%"
	return "#{bar} #{stats}"

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

combinedProgressHandler = (states, index, callback) ->
	return (evt) ->
		# update current reporter state
		states[index].current = evt.totalProgressDetail.current
		states[index].total = evt.totalProgressDetail.total
		# update totals
		current = _.sumBy(states, 'current')
		total = _.sumBy(states, 'total')
		percentage = calculatePercentage(current, total)
		# update event
		evt.totalProgress = renderProgress(percentage, current, total)
		evt.percentage = percentage
		evt.progressIndex = index
		# call callback with aggregate event
		callback(evt)

exports.DockerProgress = class DockerProgress
	constructor: (dockerOpts) ->
		if !(this instanceof DockerProgress)
			return new DockerProgress(dockerOpts)

		@docker = new Docker(dockerOpts)

	aggregateProgress: (count, onProgress) ->
		states = []
		reporters = []
		for i in [0...count]
			states.push(current: 0, total: 0)
			reporters.push(combinedProgressHandler(states, i, onProgress))
		return reporters

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
			total = totalSize * 2
			downloadSize = {}
			extractSize = {}
			return (evt) ->
				try
					{ status } = evt
					shortId = evt.id
					if evt.progressDetail? and not layerIds[shortId]?
						remapShortId(shortId, remoteLayerIds, layerIds)

					if status is 'Downloading'
						downloadSize[shortId] = evt.progressDetail.current
					else if status is 'Extracting'
						extractSize[shortId] = evt.progressDetail.current
					else if status is 'Download complete'
						remoteId = layerIds[shortId]
						downloadSize[shortId] = layerSizes[remoteId]
					else if status is 'Pull complete'
						remoteId = layerIds[shortId]
						extractSize[shortId] = layerSizes[remoteId]
					else if status is 'Already exists'
						remoteId = layerIds[shortId]
						downloadSize[shortId] = layerSizes[remoteId]
						extractSize[shortId] = layerSizes[remoteId]

					if status.match(/^Status: Image is up to date for /)
						downloadedSize = totalSize
						extractedSize = totalSize
					else
						downloadedSize = _.sum(_.values(downloadSize))
						extractedSize = _.sum(_.values(extractSize))

					completedSize = downloadedSize + extractedSize
					downloadedPercentage = calculatePercentage(downloadedSize, totalSize)
					extractedPercentage = calculatePercentage(extractedSize, totalSize)
					percentage = calculatePercentage(completedSize, total)

					onProgress _.merge evt, {
						percentage
						downloadedSize
						downloadedPercentage
						extractedSize
						extractedPercentage
						totalSize
						totalProgress: renderProgress(percentage, completedSize, total)
						totalProgressDetail:
							current: completedSize
							total: total
					}
				catch err
					console.warn('Progress error:', err.message ? err)

	# Get size of all layers of a local image
	# "image" is a string, the name of the docker image
	getImageLayerSizes: (image) ->
		d = @docker
		d.getImage(image).historyAsync()
		.then (layers) ->
			# roll-up sizes of layers with ID <missing> onto the parent.
			# for example, transforms this:
			#
			# [{"Id": "sha256:a145e85e1...", "Size": 0, ...},
			#  {"Id": "<missing>", "Size": 207, ...},
			#  {"Id": "<missing>", "Size": 2125, ...}]
			#
			# to this: [{"Id": "sha256:a145e85e1...", "Size": 2332, ...}]
			concreteLayers = []
			accumulatedSize = 0
			_.forEachRight layers, (layer) ->
				if layer.Id is '<missing>'
					accumulatedSize += layer.Size
				else
					layer.Size += accumulatedSize
					accumulatedSize = 0
					concreteLayers.push(layer)
			return concreteLayers
		.map (layer) ->
			# transform into something like this:
			# [ {id: "bb12b...", size: 1339, blobs: [ "a694d3...", ... ]}, ... ]
			d.getImage(layer['Id']).inspectAsync().then (info) ->
				id: stripShaPrefix(layer['Id'])
				size: layer['Size']
				blobs: _(info['RootFS']['Layers'])
					.map(stripShaPrefix)
					.uniq()
					.value()
		.then (layers) ->
			# each layer references all blobs it's made of. for each layer
			# keep only layer-specific blobs, dropping older ones.
			knownBlobs = null
			_.forEach layers, (layer) ->
				if not knownBlobs?
					knownBlobs = layer.blobs
					return
				layer.blobs = _.dropWhile layer.blobs, (blob) ->
					_.includes(knownBlobs, blob)
				knownBlobs = knownBlobs.concat(layer.blobs)
			return layers
		.then (layers) ->
			# distribute the layer size uniformly across each layer's blobs
			# and return a map of all known blob IDs to their size.
			_(layers)
				.flatMap (layer) ->
					blobCount = layer.blobs.length
					return [] if blobCount is 0
					blobSize = layer.size // blobCount
					remainder = layer.size - blobSize * blobCount
					_.map layer.blobs, (blobId, index) ->
						[ blobId, blobSize + (if index is 0 then remainder else 0) ]
				.fromPairs()
				.value()

	# Create a stream that transforms `docker.modem.followProgress` onProgress
	# events to include total progress metrics.
	pushProgress: (image, onProgress) ->
		@getImageLayerSizes(image)
		.then (layerSizes) ->
			layerIds = {} # map from remote to local ids
			remoteLayerIds = _.keys(layerSizes)
			totalSize = _.sum(_.values(layerSizes))
			completedSize = 0
			lastPushedSize = 0
			layerPushedSize = {}
			return (evt) ->
				try
					{ status } = evt
					shortId = evt.id
					if evt.progressDetail? and not layerIds[shortId]?
						remapShortId(shortId, remoteLayerIds, layerIds)

					pushMatch = /Image (.*) already pushed/.exec(status)

					if status is 'Pushing' and evt.progressDetail.current?
						layerPushedSize[shortId] = evt.progressDetail.current
					# registry2-only statuses
					else if status is 'Pushed' or /^Mounted from /.test(status)
						remoteId = layerIds[shortId]
						completedSize += layerSizes[remoteId]
						layerPushedSize[shortId] = 0
					# registry1-only statuses
					else if _.includes(['Already exists', 'Layer already exists', 'Image successfully pushed'], status) or pushMatch
						shortId or= pushMatch[1]
						remoteId = layerIds[shortId]
						completedSize += layerSizes[remoteId]
						layerPushedSize[shortId] = 0

					pushedSize = completedSize + _.sum(_.values(layerPushedSize))
					# docker loses track of progress for some layers.
					# don't let the progress bar jump around
					pushedSize = minmax(pushedSize, lastPushedSize, totalSize)
					percentage = calculatePercentage(pushedSize, totalSize)
					lastPushedSize = pushedSize

					onProgress _.merge evt, {
						percentage
						pushedSize
						totalSize
						totalProgress: renderProgress(percentage, pushedSize, totalSize)
						totalProgressDetail:
							current: pushedSize
							total: totalSize
					}
				catch err
					console.warn('Progress error:', err.message ? err)
