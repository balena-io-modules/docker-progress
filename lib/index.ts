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

import * as _ from 'lodash';
import type * as Stream from 'stream';

import type {
	DockerVersion,
	ImagePushOptions,
	ImageBuildOptions,
	AuthConfig,
	RegistryConfig,
} from 'dockerode';

export interface EngineVersion extends DockerVersion {
	Engine?: string;
}

export interface PullPushOptions {
	ignoreProgressErrorEvents?: boolean;
	authconfig?: AuthConfig & {
		auth?: string;
		registrytoken?: string;
	};
}

export interface BuildOptions extends ImageBuildOptions {
	ignoreProgressErrorEvents?: boolean;
	authconfig?: AuthConfig & {
		auth?: string;
		registrytoken?: string;
	};
	registryconfig?: RegistryConfig & {
		[registryAddress: string]: {
			username?: string;
			password?: string;
			auth?: string;
			registrytoken?: string;
		};
	};
}

export type ProgressCallback = (eventObj: any) => void;

const DEFAULT_PROGRESS_BAR_STEP_COUNT = 50;

function tryExtractDigestHash(evt: {
	aux?: { Digest?: string };
	status?: any;
}): string | undefined {
	if (evt.aux && evt.aux.Digest) {
		return evt.aux.Digest;
	}
	if (typeof evt.status === 'string') {
		const matchPull = evt.status.match(/^Digest:\s([a-zA-Z0-9]+:[a-f0-9]+)$/);
		if (matchPull != null) {
			return matchPull[1];
		}
	}
}

function awaitRegistryStream(
	stream: NodeJS.ReadableStream,
	onProgress: ProgressCallback,
	ignoreErrorEvents: boolean,
): Promise<string> {
	return new Promise((resolve, reject) => {
		let contentHash = '';
		const JSONStream = require('JSONStream');
		const jsonStream: NodeJS.ReadWriteStream = JSONStream.parse();

		jsonStream.on('error', reject);
		jsonStream.on('end', () => resolve(contentHash));
		jsonStream.on('data', (evt: any) => {
			if (typeof evt !== 'object') {
				return;
			}
			try {
				if (evt.error && !ignoreErrorEvents) {
					throw new Error(evt.error);
				}
				// try to extract the digest before forwarding the object
				const maybeContent = tryExtractDigestHash(evt);
				if (maybeContent != null) {
					contentHash = maybeContent;
				}
				onProgress(evt);
			} catch (error) {
				try {
					(stream as NodeJS.ReadStream).destroy(error as Error);
					reject(error);
				} catch (err) {
					stream.emit('error', error);
				}
			}
		});

		stream.pipe(jsonStream);
	});
}

/**
 * Build and return a Docker-like progress bar like this:
 * [==================================>               ] 64%
 */
function $renderProgress(percentage: number, stepCount: number): string {
	percentage = _.clamp(percentage, 0, 100);
	const barCount = Math.floor((stepCount * percentage) / 100);
	const spaceCount = stepCount - barCount;
	const bar = `[${_.repeat('=', barCount)}>${_.repeat(' ', spaceCount)}]`;
	return `${bar} ${percentage}%`;
}

class ProgressTracker {
	protected layers: {
		[id: string]: { progress: number | null; coalesced: boolean };
	} = {};
	constructor(protected coalesceBelow = 0) {}

	addLayer(id: string) {
		this.layers[id] = { progress: null, coalesced: false };
	}

	linkLayer(id: string, tracker: ProgressTracker) {
		this.layers[id] = tracker.layers[id];
	}

	updateLayer(id: string, progress: { current: number; total: number }) {
		if (id == null) {
			return;
		}
		if (!this.layers[id]) {
			this.addLayer(id);
		}
		this.patchProgressEvent(progress);
		this.layers[id].coalesced =
			this.layers[id].progress == null && progress.total < this.coalesceBelow;
		this.layers[id].progress = progress.current / progress.total || 0; // prevent NaN when .total = 0
	}

	finishLayer(id: string) {
		this.updateLayer(id, { current: 1, total: 1 });
	}

	getProgress(): number {
		const layers = _.filter(this.layers, { coalesced: false });
		const avgProgress = _.meanBy(layers, 'progress') || 0;
		return Math.round(100 * avgProgress);
	}

	patchProgressEvent(progress: { current: number; total: number }) {
		// some events arrive without .total
		if (progress.total == null) {
			progress.total = progress.current;
		}
		// some events arrive with .current > .total
		progress.current = Math.min(progress.current, progress.total);
	}
}

class ProgressReporter {
	constructor(protected renderProgress: (percent: number) => string) {}

	protected checkProgressError(error: Error, extraInfo: string) {
		const prefix = `Progress error: [${extraInfo}]`;
		console.warn(prefix, error.message || error);
		error.message = `${prefix} ${error.message}`;
		throw error;
	}

	/**
	 * Return an image pull progress event handler that wraps another, transforming
	 * the image pull progress events to add some fields:
	 *   percentage, downloadedPercentage, extractedPercentage, totalProgress
	 *
	 * @param onProgress Image pull progress event handler to be wrapped
	 */
	pullProgress(onProgress: ProgressCallback): ProgressCallback {
		const progressRenderer = this.renderProgress;
		const downloadProgressTracker = new ProgressTracker(100 * 1024); // 100 KB
		const extractionProgressTracker = new ProgressTracker(1024 * 1024); // 1 MB
		let lastPercentage = 0;
		return (evt: any) => {
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

				onProgress(
					_.merge(evt, {
						percentage,
						downloadedPercentage,
						extractedPercentage,
						totalProgress: progressRenderer(percentage),
					}),
				);
			} catch (err) {
				this.checkProgressError(err as Error, `pull id=${id} status=${status}`);
			}
		};
	}

	buildProgress(onProgress: ProgressCallback): ProgressCallback {
		const progressRenderer = this.renderProgress;
		let lastStep = 1;
		let step = 0;
		let total = 1;
		let lastPercentage = 0;

		let progressCallback: ProgressCallback = () => void 0;

		return (evt: any) => {
			let stream;
			let id;
			let status;
			try {
				({ id, stream, status } = evt);
				id ||= '';
				status ||= '';
				stream ||= '';

				// Check for a `Step n/total` message on the stream
				const streamComponents = stream.match(/^Step (\d+)\/(\d+)\s*:\s*(.+)/);
				if (streamComponents != null) {
					let instruction = '';
					[, step, total, instruction] = streamComponents;
					step ||= 1;
					total ||= 1;
					instruction ||= '';

					// Normalize the lastPercentage by the number of steps
					lastPercentage = Math.floor((100 * (step - 1)) / total);

					// The `Step n/total` is only shown at the beginning
					// of the step. We re-create the pullProgress using the
					// new total step value
					if (step >= lastStep) {
						if (instruction.toLowerCase().startsWith('from')) {
							// If this is a FROM instruction, delegate progress to a new pullProgress
							// callback
							progressCallback = this.pullProgress(({ percentage, ...e }) => {
								// Scale the progress from the pull step by the number of steps
								percentage = Math.floor((step * percentage) / total);
								percentage = lastPercentage = Math.max(
									lastPercentage,
									percentage,
								);
								onProgress({
									...e,
									percentage,
									// Re-render the progress with the new value
									totalProgress: progressRenderer(percentage),
								});
							});
						} else {
							// Otherwise percentage will only increase with each step so we just
							// use that as percentage
							progressCallback = (e: any) =>
								onProgress({
									...e,
									percentage: lastPercentage,
									totalProgress: progressRenderer(lastPercentage),
								});
						}
					}
					lastStep = step;
				}

				// Update the last percentage if the last step is finished
				if (stream.startsWith('Successfully built')) {
					lastPercentage = 100;
				}

				// Pass the event to the progress callback for rendering
				progressCallback(evt);
			} catch (err) {
				this.checkProgressError(
					err as Error,
					`build stream=${stream} id=${id} status=${status}`,
				);
			}
		};
	}

	/**
	 * Return an image push progress event handler that wraps another, transforming
	 * the image push progress events to add some fields:
	 *   id, percentage, totalProgress
	 *
	 * @param onProgress Image push progress event handler to be wrapped
	 */
	pushProgress(onProgress: ProgressCallback): ProgressCallback {
		const progressRenderer = this.renderProgress;
		const progressTracker = new ProgressTracker(100 * 1024); // 100 KB
		let lastPercentage = 0;
		return (evt: any) => {
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
				} else if (status === 'Pushing' && evt.progressDetail.current != null) {
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

				onProgress(
					_.merge(evt, {
						id,
						percentage,
						totalProgress: progressRenderer(percentage),
					}),
				);
			} catch (err) {
				this.checkProgressError(err as Error, `push id=${id} status=${status}`);
			}
		};
	}
}

class BalenaProgressReporter extends ProgressReporter {
	/**
	 * Return an image pull progress event handler that wraps another, transforming
	 * the image pull progress events to add some fields:
	 *   percentage, downloadedPercentage, extractedPercentage, totalProgress
	 *
	 * @param onProgress Image pull progress event handler to be wrapped
	 */
	pullProgress(onProgress: ProgressCallback): ProgressCallback {
		const progressRenderer = this.renderProgress;
		let lastPercentage = 0;
		return (evt: any) => {
			let id;
			try {
				({ id } = evt);

				if (id !== 'Total') {
					return;
				}

				let { current, total } = evt.progressDetail;

				// sanity check.
				if (isNaN(current)) {
					current = 0;
				}
				if (isNaN(total)) {
					total = current + 1;
				}

				let percentage = Math.floor((current * 100) / total);
				percentage = lastPercentage = Math.max(percentage, lastPercentage);

				onProgress(
					_.merge(evt, {
						percentage,
						downloadedPercentage: current,
						extractedPercentage: current,
						totalProgress: progressRenderer(percentage),
					}),
				);
			} catch (err) {
				this.checkProgressError(err as Error, `balena pull id=${id}`);
			}
		};
	}
}

export interface DockerProgressOpts {
	docker: import('dockerode');
	// optional: cached result of dockerode's docker.version()
	dockerVersionObj?: EngineVersion;
}

export class DockerProgress {
	docker: import('dockerode');

	protected reporter?: ProgressReporter;
	protected engineVersion?: EngineVersion;
	private engineVersionPromise?: Promise<EngineVersion>;

	constructor(protected opts: DockerProgressOpts) {
		this.docker = opts.docker;
		this.engineVersion = opts.dockerVersionObj;
	}

	protected getProgressRenderer(
		stepCount = DEFAULT_PROGRESS_BAR_STEP_COUNT,
	): (percentage: number) => string {
		return (percentage: number) => $renderProgress(percentage, stepCount);
	}

	protected async getProgressReporter(): Promise<ProgressReporter> {
		if (this.reporter != null) {
			return this.reporter;
		}
		const renderer = this.getProgressRenderer();
		this.reporter = (await this.isBalenaEngine())
			? new BalenaProgressReporter(renderer)
			: new ProgressReporter(renderer);
		return this.reporter;
	}

	aggregateProgress(
		count: number,
		onProgress: ProgressCallback,
	): ProgressCallback[] {
		const renderer = this.getProgressRenderer();
		const states = _.times(count, () => ({
			percentage: 0,
		}));
		return _.times(
			count,
			(index) =>
				function (evt: any): void {
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
					onProgress(evt);
				},
		);
	}

	/** Pull docker image calling onProgress with extended progress info regularly */
	async pull(
		image: string,
		onProgress: ProgressCallback,
		options?: PullPushOptions,
	): Promise<string> {
		const ignoreErrorEvents = !!options?.ignoreProgressErrorEvents;
		const reporter = await this.getProgressReporter();
		onProgress = reporter.pullProgress(onProgress);
		const stream = await this.docker.pull(image, options);
		const hash = await awaitRegistryStream(
			stream,
			onProgress,
			ignoreErrorEvents,
		);
		return hash;
	}

	/** Push docker image calling onProgress with extended progress info regularly */
	async push(
		image: string,
		onProgress: ProgressCallback,
		options?: PullPushOptions,
	): Promise<string> {
		const ignoreErrorEvents = !!options?.ignoreProgressErrorEvents;
		const reporter = await this.getProgressReporter();
		onProgress = reporter.pushProgress(onProgress);
		const imageObj = this.docker.getImage(image);
		const stream = await imageObj.push(options as ImagePushOptions);
		const hash = await awaitRegistryStream(
			stream,
			onProgress,
			ignoreErrorEvents,
		);
		return hash;
	}

	/** Build docker image calling onProgress with extended progress info regularly */
	async build(
		tarStream: Stream.Readable,
		onProgress: ProgressCallback,
		options?: BuildOptions,
	): Promise<string> {
		const ignoreErrorEvents = !!options?.ignoreProgressErrorEvents;

		// Authconfig is not supported by docker `/build` endpoint but we support
		// it here to provide a common interface with the `pull()` method
		if (options?.authconfig) {
			const { serveraddress, ...authconfig } = options.authconfig;
			options.registryconfig = {
				[serveraddress]: authconfig,

				// Override with registryconfig if it the same serveraddress
				// is used in both options
				...options.registryconfig,
			};

			delete options.authconfig;
		}

		const reporter = await this.getProgressReporter();
		onProgress = reporter.buildProgress(onProgress);
		const stream = await this.docker.buildImage(tarStream, options);
		const hash = await awaitRegistryStream(
			stream,
			onProgress,
			ignoreErrorEvents,
		);

		return hash;
	}

	async isBalenaEngine(): Promise<boolean> {
		if (!this.engineVersion) {
			// optimization for simultaneous async calls to pull()
			// or push() with Promise.all(...)
			if (!this.engineVersionPromise) {
				this.engineVersionPromise = this.docker.version();
			}
			this.engineVersion = await this.engineVersionPromise;
			this.engineVersionPromise = undefined;
		}
		return ['balena', 'balaena', 'balena-engine'].includes(
			this.engineVersion['Engine'] || '',
		);
	}
}
