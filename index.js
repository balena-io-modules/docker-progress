/**
 * @license
 * Copyright 2016-2021 Balena Ltd.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const _ = require('lodash');
const Promise = require('bluebird');
const Docker = require('docker-toolbelt');
const JSONStream = require('JSONStream');

const DEFAULT_PROGRESS_BAR_STEP_COUNT = 50;

const tryExtractDigestHash = function (evt) {
	if (evt.aux != null && evt.aux.Digest != null) {
		return evt.aux.Digest;
	}
	if (_.isString(evt.status)) {
		const matchPull = evt.status.match(/^Digest:\s([a-zA-Z0-9]+:[a-f0-9]+)$/);
		if (matchPull != null) {
			return matchPull[1];
		}
	}
};

const awaitRegistryStream = function (stream, onProgress, ignoreErrorEvents) {
	let contentHash = null;
	return new Promise(function (resolve, reject) {
		const jsonStream = JSONStream.parse();

		jsonStream.on('data', function (evt) {
			if (typeof evt !== 'object') {
				return;
			}
			try {
				if (evt.error && !ignoreErrorEvents) {
					throw new Error(evt.error);
				}

				// try to extract the digest before forwarding the
				// object
				const maybeContent = tryExtractDigestHash(evt);
				if (maybeContent != null) {
					contentHash = maybeContent;
				}

				return onProgress(evt);
			} catch (error) {
				stream.destroy(error);
				return reject(error);
			}
		});
		jsonStream.on('error', reject);
		jsonStream.on('end', () => resolve(contentHash));

		return stream.pipe(jsonStream);
	});
};

const isBalenaEngine = (versionInfo) =>
	['balena', 'balaena', 'balena-engine'].includes(versionInfo['Engine']);

// Builds and returns a Docker-like progress bar like this:
// [==================================>               ] 64%
const renderProgress = function (percentage, stepCount) {
	percentage = _.clamp(percentage, 0, 100);
	const barCount = Math.floor((stepCount * percentage) / 100);
	const spaceCount = stepCount - barCount;
	const bar = `[${_.repeat('=', barCount)}>${_.repeat(' ', spaceCount)}]`;
	return `${bar} ${percentage}%`;
};

const onProgressHandler = function (onProgressPromise, fallbackOnProgress) {
	let evts = [];
	let onProgress = (evt) => evts.push(evt);

	const handlePreviousEvents = function ($onProgress) {
		_.map(evts, function (evt) {
			try {
				return $onProgress(evt);
			} catch (error) {
				// pass
			}
		});
		return (evts = []);
	};

	// Once the onProgressPromise is fulfilled we switch `onProgress` to the real callback,
	// or the fallback if it fails, and then call it with all the previously received events in order
	onProgressPromise
		.then(function (resolvedOnProgress) {
			onProgress = resolvedOnProgress;
			return handlePreviousEvents(resolvedOnProgress);
		})
		.catch(function (e) {
			console.warn('error', e);
			onProgress = fallbackOnProgress;
			return handlePreviousEvents(fallbackOnProgress);
		});
	// Return an indirect call to `onProgress` so that we can switch to the
	// real onProgress function when the promise resolves
	return (evt) => onProgress(evt);
};

class ProgressTracker {
	constructor(coalesceBelow) {
		if (coalesceBelow == null) {
			coalesceBelow = 0;
		}
		this.coalesceBelow = coalesceBelow;
		this.layers = {};
	}

	addLayer(id) {
		return (this.layers[id] = { progress: null, coalesced: false });
	}

	linkLayer(id, tracker) {
		return (this.layers[id] = tracker.layers[id]);
	}

	updateLayer(id, progress) {
		if (id == null) {
			return;
		}
		if (!this.layers[id]) {
			this.addLayer(id);
		}
		this.patchProgressEvent(progress);
		this.layers[id].coalesced =
			this.layers[id].progress == null && progress.total < this.coalesceBelow;
		return (this.layers[id].progress = progress.current / progress.total || 0); // prevent NaN when .total = 0
	}

	finishLayer(id) {
		return this.updateLayer(id, { current: 1, total: 1 });
	}

	getProgress() {
		const layers = _.filter(this.layers, { coalesced: false });
		const avgProgress = _.meanBy(layers, 'progress') || 0;
		return Math.round(100 * avgProgress);
	}

	patchProgressEvent(progress) {
		// some events arrive without .total
		if (progress.total == null) {
			progress.total = progress.current;
		}
		// some events arrive with .current > .total
		return (progress.current = Math.min(progress.current, progress.total));
	}
}

class ProgressReporter {
	static initClass() {
		// Return a promise that resolves to a stream event handler suitable for use
		// as the handler of a docker daemon's onProgress events for an image pull.
		this.prototype.pullProgress = Promise.method(function (image, onProgress) {
			const progressRenderer = this.renderProgress;
			const downloadProgressTracker = new ProgressTracker(100 * 1024); // 100 KB
			const extractionProgressTracker = new ProgressTracker(1024 * 1024); // 1 MB
			let lastPercentage = 0;
			return (evt) => {
				let id;
				let status;
				try {
					let downloadedPercentage;
					let extractedPercentage;
					({ id, status } = evt);
					if (id == null) {
						id = '';
					}
					if (status == null) {
						status = '';
					}

					if (status === 'Pulling fs layer') {
						downloadProgressTracker.addLayer(id);
						extractionProgressTracker.addLayer(id);
					} else if (status === 'Ready to download') {
						// balena-os/balena-engine extracts layers as they're downloaded and omits
						// download stage events completely, only emitting extraction events.
						// We determine this is the case from the 'Ready to download' event
						// emitted once for each layer by balena-os/balena-engine at the start of
						// the pull. We then create a "link" of the progress record for the layer
						// between the download and extraction progress trackers by sharing
						// the record "pointer", so that later events affect progress in both
						// trackers. This simplifies handling this case a lot, because it
						// allows us to continue to assume there's always two stages in pull.
						downloadProgressTracker.linkLayer(id, extractionProgressTracker);
					} else if (status === 'Downloading') {
						downloadProgressTracker.updateLayer(id, evt.progressDetail);
					} else if (status === 'Extracting') {
						extractionProgressTracker.updateLayer(id, evt.progressDetail);
					} else if (status === 'Download complete') {
						downloadProgressTracker.finishLayer(id);
					} else if (status === 'Pull complete') {
						extractionProgressTracker.finishLayer(id);
					} else if (status === 'Already exists') {
						downloadProgressTracker.finishLayer(id);
						extractionProgressTracker.finishLayer(id);
					}

					if (
						status.startsWith('Status: Image is up to date for ') ||
						status.startsWith('Status: Downloaded newer image for ')
					) {
						downloadedPercentage = 100;
						extractedPercentage = 100;
					} else {
						downloadedPercentage = downloadProgressTracker.getProgress();
						extractedPercentage = extractionProgressTracker.getProgress();
					}

					let percentage = Math.floor(
						(downloadedPercentage + extractedPercentage) / 2,
					);
					percentage = lastPercentage = Math.max(percentage, lastPercentage);

					return onProgress(
						_.merge(evt, {
							percentage,
							downloadedPercentage,
							extractedPercentage,
							totalProgress: progressRenderer(percentage),
						}),
					);
				} catch (err) {
					return this.checkProgressError(err, `pull id=${id} status=${status}`);
				}
			};
		});

		// Create a stream that transforms docker daemon's onProgress
		// events to include total progress metrics.
		this.prototype.pushProgress = Promise.method(function (image, onProgress) {
			const progressRenderer = this.renderProgress;
			const progressTracker = new ProgressTracker(100 * 1024); // 100 KB
			let lastPercentage = 0;
			return (evt) => {
				let id;
				let status;
				try {
					({ id, status } = evt);

					const pushMatch = /Image (.*) already pushed/.exec(status);

					if (id == null) {
						id = pushMatch != null ? pushMatch[1] : undefined;
					}
					if (status == null) {
						status = '';
					}

					if (status === 'Preparing') {
						progressTracker.addLayer(id);
					} else if (
						status === 'Pushing' &&
						evt.progressDetail.current != null
					) {
						progressTracker.updateLayer(id, evt.progressDetail);
						// registry v2 statuses
					} else if (
						_.includes(
							['Pushed', 'Layer already exists', 'Image already exists'],
							status,
						) ||
						/^Mounted from /.test(status)
					) {
						progressTracker.finishLayer(id);
						// registry v1 statuses
					} else if (
						pushMatch != null ||
						_.includes(['Already exists', 'Image successfully pushed'], status)
					) {
						progressTracker.finishLayer(id);
					}

					let percentage =
						status.search(/.+: digest: /) === 0 ||
						status.startsWith('Pushing tag for rev ')
							? 100
							: progressTracker.getProgress();

					percentage = lastPercentage = Math.max(percentage, lastPercentage);

					return onProgress(
						_.merge(evt, {
							id,
							percentage,
							totalProgress: progressRenderer(percentage),
						}),
					);
				} catch (err) {
					return this.checkProgressError(err, `push id=${id} status=${status}`);
				}
			};
		});
	}
	constructor(renderProgress1) {
		this.renderProgress = renderProgress1; //
	}

	checkProgressError(error, extraInfo) {
		const prefix = `Progress error: [${extraInfo}]`;
		console.warn(prefix, error.message != null ? error.message : error);
		error.message = `${prefix} ${error.message}`;
		throw error;
	}
}
ProgressReporter.initClass();

class BalenaProgressReporter extends ProgressReporter {
	static initClass() {
		this.prototype.pullProgress = Promise.method(function (image, onProgress) {
			const progressRenderer = this.renderProgress;
			let lastPercentage = 0;
			return (evt) => {
				let id;
				try {
					({ id } = evt);

					if (id !== 'Total') {
						return;
					}

					const { current, total } = evt.progressDetail;
					let percentage = Math.floor((current * 100) / total);
					percentage = lastPercentage = Math.max(percentage, lastPercentage);

					return onProgress(
						_.merge(evt, {
							percentage,
							downloadedPercentage: current,
							extractedPercentage: current,
							totalProgress: progressRenderer(percentage),
						}),
					);
				} catch (err) {
					return this.checkProgressError(err, `balena pull id=${id}`);
				}
			};
		});
	}
}
BalenaProgressReporter.initClass();

class DockerProgress {
	constructor(opts) {
		if (opts == null) {
			opts = {};
		}
		if (!(this instanceof DockerProgress)) {
			return new DockerProgress(opts);
		}
		if (opts.dockerToolbelt != null) {
			if (
				!_.isFunction(opts.dockerToolbelt.getRegistryAndName) ||
				(opts.dockerToolbelt.modem != null
					? opts.dockerToolbelt.modem.Promise
					: undefined) == null
			) {
				throw new Error(
					'Invalid dockerToolbelt option, please use an instance of docker-toolbelt v3.0.1 or higher',
				);
			}
			this.docker = opts.dockerToolbelt;
		} else {
			this.docker = new Docker(opts);
		}
		this.reporter = null;
	}

	getProgressRenderer(stepCount) {
		if (stepCount == null) {
			stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT;
		}
		return (percentage) => renderProgress(percentage, stepCount);
	}

	getProgressReporter() {
		if (this.reporter != null) {
			return this.reporter;
		}
		const { docker } = this;
		const renderer = this.getProgressRenderer();
		return (this.reporter = docker.version().then(function (res) {
			const version = res['Version'];
			if (isBalenaEngine(res)) {
				return new BalenaProgressReporter(renderer);
			} else {
				return new ProgressReporter(renderer);
			}
		}));
	}

	aggregateProgress(count, onProgress) {
		const renderer = this.getProgressRenderer();
		const states = _.times(count, () => ({
			percentage: 0,
		}));
		return _.times(
			count,
			(index) =>
				function (evt) {
					// update current reporter state
					states[index].percentage = evt.percentage;
					// update totals
					const percentage = Math.floor(
						_.sumBy(states, 'percentage') / (states.length || 1),
					);
					// update event
					evt.totalProgress = renderer(percentage);
					evt.percentage = percentage;
					evt.progressIndex = index;
					// call callback with aggregate event
					return onProgress(evt);
				},
		);
	}

	// Pull docker image calling onProgress with extended progress info regularly
	pull(image, onProgress, options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = null;
		}

		const ignoreErrorEvents = !!(options != null
			? options.ignoreProgressErrorEvents
			: undefined);
		const onProgressPromise = this.pullProgress(image, onProgress);
		onProgress = onProgressHandler(onProgressPromise, onProgress);
		return this.docker
			.pull(image, options)
			.then((stream) =>
				awaitRegistryStream(stream, onProgress, ignoreErrorEvents),
			)
			.nodeify(callback);
	}

	// Push docker image calling onProgress with extended progress info regularly
	push(image, onProgress, options, callback) {
		const ignoreErrorEvents = !!(options != null
			? options.ignoreProgressErrorEvents
			: undefined);
		const onProgressPromise = this.pushProgress(image, onProgress);
		onProgress = onProgressHandler(onProgressPromise, onProgress);
		return this.docker
			.getImage(image)
			.push(options)
			.then((stream) =>
				awaitRegistryStream(stream, onProgress, ignoreErrorEvents),
			)
			.nodeify(callback);
	}

	// Create a stream that transforms docker daemon's onProgress
	// events to include total progress metrics.
	pullProgress(image, onProgress) {
		return this.getProgressReporter().then((reporter) =>
			reporter.pullProgress(image, onProgress),
		);
	}

	// Create a stream that transforms docker daemon's onProgress
	// events to include total progress metrics.
	pushProgress(image, onProgress) {
		return this.getProgressReporter().then((reporter) =>
			reporter.pushProgress(image, onProgress),
		);
	}
}
exports.DockerProgress = DockerProgress;
