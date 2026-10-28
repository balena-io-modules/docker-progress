import { PassThrough } from 'node:stream';
import { expect } from 'chai';

import { DockerProgress } from '../lib/index';

describe('awaitRegistryStream', () => {
	it('pull() rejects when the Docker response stream emits an error', async () => {
		const sourceStream = new PassThrough();

		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			pull: async () => sourceStream,
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.destroy(new Error('socket hang up'));
		}, 50);

		try {
			await dp.pull('test-image', () => {});
			expect.fail('Expected promise to reject');
		} catch (err: any) {
			expect(err).to.be.an.instanceOf(Error);
			expect(err.message).to.equal('socket hang up');
		}
	});

	it('push() rejects when the Docker response stream emits an error', async () => {
		const sourceStream = new PassThrough();

		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			getImage: () => ({
				push: async () => sourceStream,
			}),
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.destroy(new Error('read ECONNRESET'));
		}, 50);

		try {
			await dp.push('test-image', () => {});
			expect.fail('Expected promise to reject');
		} catch (err: any) {
			expect(err).to.be.an.instanceOf(Error);
			expect(err.message).to.equal('read ECONNRESET');
		}
	});

	it('build() rejects when the Docker response stream emits an error', async () => {
		const sourceStream = new PassThrough();
		const tarStream = new PassThrough();

		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			buildImage: async () => sourceStream,
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.destroy(new Error('context canceled'));
		}, 50);

		try {
			await dp.build(tarStream, () => {});
			expect.fail('Expected promise to reject');
		} catch (err: any) {
			expect(err).to.be.an.instanceOf(Error);
			expect(err.message).to.equal('context canceled');
		}
	});
});

describe('isBalenaEngine', () => {
	it('retries docker.version() after a failure', async () => {
		let calls = 0;
		const mockDocker = {
			version: async () => {
				calls++;
				if (calls === 1) {
					throw new Error('connect ECONNREFUSED');
				}
				return { Version: '20.10.0', Engine: 'balena-engine' };
			},
		};
		const dp = new DockerProgress({ docker: mockDocker as any });

		try {
			await dp.isBalenaEngine();
			expect.fail('Expected promise to reject');
		} catch (err: any) {
			expect(err.message).to.equal('connect ECONNREFUSED');
		}
		expect(await dp.isBalenaEngine()).to.equal(true);
		expect(calls).to.equal(2);
	});

	it('shares a single docker.version() call between concurrent callers', async () => {
		let calls = 0;
		const mockDocker = {
			version: async () => {
				calls++;
				return { Version: '20.10.0' };
			},
		};
		const dp = new DockerProgress({ docker: mockDocker as any });

		expect(
			await Promise.all([dp.isBalenaEngine(), dp.isBalenaEngine()]),
		).to.deep.equal([false, false]);
		expect(calls).to.equal(1);
	});
});

describe('digest extraction', () => {
	const digest = `sha256:${'a'.repeat(64)}`;

	const streamOf = (events: object[]) => {
		const stream = new PassThrough();
		for (const evt of events) {
			stream.write(JSON.stringify(evt) + '\r\n');
		}
		stream.end();
		return stream;
	};

	it('pull() resolves with the digest from the `Digest: <digest>` status', async () => {
		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			pull: async () =>
				streamOf([
					{ status: 'Pulling from library/alpine', id: 'latest' },
					{ status: `Digest: ${digest}` },
					{ status: 'Status: Downloaded newer image for alpine:latest' },
				]),
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		expect(await dp.pull('alpine', () => {})).to.equal(digest);
	});

	it('push() resolves with the digest from the `<tag>: digest: <digest> size: <size>` status', async () => {
		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			getImage: () => ({
				push: async () =>
					streamOf([{ status: `latest: digest: ${digest} size: 1234` }]),
			}),
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		expect(await dp.push('alpine', () => {})).to.equal(digest);
	});

	it('build() does not resolve with the digest of a pulled base image', async () => {
		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			// The classic builder streams the pull of the FROM image
			buildImage: async () =>
				streamOf([
					{ stream: 'Step 1/1 : FROM alpine' },
					{ status: 'Pulling from library/alpine', id: 'latest' },
					{ status: `Digest: ${digest}` },
					{ status: 'Status: Downloaded newer image for alpine:latest' },
				]),
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		expect(await dp.build(new PassThrough(), () => {})).to.equal('');
	});
});

describe('awaitRegistryStream premature close', () => {
	const withTimeout = async <T>(promise: Promise<T>) => {
		let timer: NodeJS.Timeout | undefined;
		try {
			return await Promise.race([
				promise,
				new Promise<never>((_resolve, reject) => {
					timer = setTimeout(() => reject(new Error('Timed out')), 1000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	};

	it('pull() rejects when the Docker response stream closes without ending', async () => {
		const sourceStream = new PassThrough();

		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			pull: async () => sourceStream,
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.write(
				JSON.stringify({ status: 'Pulling fs layer', id: 'layer' }) + '\r\n',
			);
			sourceStream.destroy();
		}, 50);

		try {
			await withTimeout(dp.pull('test-image', () => {}));
			expect.fail('Expected promise to reject');
		} catch (err: any) {
			expect(err).to.be.an.instanceOf(Error);
			expect(err.code).to.equal('ERR_STREAM_PREMATURE_CLOSE');
		}
	});

	it('pull() still resolves when the Docker response stream ends', async () => {
		const sourceStream = new PassThrough();

		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			pull: async () => sourceStream,
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.end(
				JSON.stringify({ status: 'Pulling fs layer', id: 'layer' }) + '\r\n',
			);
		}, 50);

		expect(await withTimeout(dp.pull('test-image', () => {}))).to.equal('');
	});
});

describe('delta progress', () => {
	it('includes totalProgress in the final 100% event', async () => {
		const mockDocker = { version: async () => ({ Version: '20.10.0' }) };
		const dp = new DockerProgress({ docker: mockDocker as any });
		const events: any[] = [];
		const onProgress = await dp.makeDeltaProgressReporter((e) =>
			events.push(e),
		);

		onProgress({ status: 'Fingerprint complete' });
		onProgress({ status: `Created delta: sha256:${'a'.repeat(64)}` });

		expect(events).to.have.length(2);
		expect(events[0]).to.have.property('percentage', 25);
		expect(events[1]).to.deep.equal({
			percentage: 100,
			totalProgress: `[${'='.repeat(50)}>] 100%`,
		});
	});
});

describe('build progress', () => {
	const getReporter = async () => {
		const mockDocker = { version: async () => ({ Version: '20.10.0' }) };
		const dp = new DockerProgress({ docker: mockDocker as any });
		return await dp['getProgressReporter']();
	};

	it('tracks the pull progress of a FROM at step 10', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.buildProgress((e) => events.push(e));
		for (let i = 1; i <= 9; i++) {
			onProgress({ stream: `Step ${i}/12 : RUN echo ${i}` });
		}
		onProgress({ stream: 'Step 10/12 : FROM alpine' });
		onProgress({ status: 'Pulling fs layer', id: 'layer' });
		onProgress({
			status: 'Downloading',
			id: 'layer',
			progressDetail: { current: 25_000_000, total: 50_000_000 },
		});

		expect(events[events.length - 1]).to.have.property(
			'downloadedPercentage',
			50,
		);
	});

	it('stops tracking pull progress after a FROM at step 9 when step 10 starts', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.buildProgress((e) => events.push(e));
		for (let i = 1; i <= 8; i++) {
			onProgress({ stream: `Step ${i}/12 : RUN echo ${i}` });
		}
		onProgress({ stream: 'Step 9/12 : FROM alpine' });
		onProgress({ stream: 'Step 10/12 : RUN echo 10' });

		expect(events[events.length - 1]).to.not.have.property(
			'downloadedPercentage',
		);
		expect(events[events.length - 1]).to.have.property('percentage', 75);
	});
});

describe('options', () => {
	const endedStream = () => {
		const stream = new PassThrough();
		stream.end();
		return stream;
	};

	const getDocker = () => {
		const received: any[] = [];
		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			pull: async (_image: string, opts: any) => {
				received.push(opts);
				return endedStream();
			},
			getImage: () => ({
				push: async (opts: any) => {
					received.push(opts);
					return endedStream();
				},
			}),
			buildImage: async (_tarStream: any, opts: any) => {
				received.push(opts);
				return endedStream();
			},
		};
		return {
			received,
			dp: new DockerProgress({ docker: mockDocker as any }),
		};
	};

	it('does not send ignoreProgressErrorEvents to the engine', async () => {
		const { dp, received } = getDocker();

		const options = { ignoreProgressErrorEvents: true };
		await dp.pull('alpine', () => {}, options);
		await dp.push('alpine', () => {}, options);
		await dp.build(new PassThrough(), () => {}, { ...options, t: 'alpine' });

		expect(received).to.have.length(3);
		for (const opts of received) {
			expect(opts).to.not.have.property('ignoreProgressErrorEvents');
		}
		expect(received[2]).to.have.property('t', 'alpine');
	});

	it('treats null options like undefined', async () => {
		const { dp, received } = getDocker();

		await dp.pull('alpine', () => {}, null as any);
		await dp.push('alpine', () => {}, null as any);
		await dp.build(new PassThrough(), () => {}, null as any);

		expect(received).to.have.length(3);
		for (const opts of received) {
			// dockerode treats null and undefined options like `{}`
			expect(opts ?? {}).to.deep.equal({});
		}
	});

	it('does not modify the build() options, so they can be reused for a retry', async () => {
		const received: any[] = [];
		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			buildImage: async (_tarStream: any, opts: any) => {
				received.push({ ...opts });
				// Mirror dockerode/docker-modem, which remove these from the options
				delete opts.authconfig;
				delete opts.registryconfig;
				delete opts.abortSignal;
				return endedStream();
			},
		};
		const dp = new DockerProgress({ docker: mockDocker as any });

		const abortSignal = new AbortController().signal;
		const options = {
			t: 'alpine',
			abortSignal,
			authconfig: {
				username: 'user',
				password: 'pass',
				serveraddress: 'registry.example.com',
			},
		};
		const originalOptions = { ...options };
		await dp.build(new PassThrough(), () => {}, options);
		await dp.build(new PassThrough(), () => {}, options);

		expect(options).to.deep.equal(originalOptions);
		expect(received).to.have.length(2);
		for (const opts of received) {
			expect(opts).to.deep.equal({
				t: 'alpine',
				abortSignal,
				registryconfig: {
					'registry.example.com': { username: 'user', password: 'pass' },
				},
			});
		}
	});
});

describe('awaitRegistryStream invalid JSON', () => {
	it('pull() rejects and destroys the Docker response stream on invalid JSON', async () => {
		const sourceStream = new PassThrough();

		const mockDocker = {
			version: async () => ({ Version: '20.10.0' }),
			pull: async () => sourceStream,
		};

		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.write(
				JSON.stringify({ status: 'Pulling fs layer', id: 'layer' }) +
					'\r\n<html>Bad Gateway</html>\r\n',
			);
		}, 50);

		let err: any;
		try {
			await dp.pull('test-image', () => {});
		} catch (e) {
			err = e;
		}
		expect(err).to.be.an.instanceOf(Error);
		expect(err.message).to.match(/^Invalid JSON/);
		expect(sourceStream.destroyed).to.equal(true);
	});
});

describe('build() with BuildKit', () => {
	it('does not fail on events with a non-object aux', async () => {
		const sourceStream = new PassThrough();
		const mockDocker = {
			version: async () => ({ Version: '27.0.0' }),
			buildImage: async () => sourceStream,
		};
		const dp = new DockerProgress({ docker: mockDocker as any });

		setTimeout(() => {
			sourceStream.end(
				// BuildKit trace events have a base64 encoded protobuf as their aux
				JSON.stringify({ id: 'moby.buildkit.trace', aux: 'CmsKR3NoYTI1Ng==' }) +
					'\r\n',
			);
		}, 50);

		expect(
			await dp.build(new PassThrough(), () => {}, { version: '2' }),
		).to.equal('');
	});
});

describe('balena-engine pull progress', () => {
	const getReporter = async () => {
		const mockDocker = {
			version: async () => ({ Version: '20.10.0', Engine: 'balena-engine' }),
		};
		const dp = new DockerProgress({ docker: mockDocker as any });
		return await dp['getProgressReporter']();
	};

	it('reports the downloaded/extracted percentages rather than byte counts', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.pullProgress((e) => events.push(e));

		onProgress({
			id: 'Total',
			progressDetail: { current: 5_000_000, total: 10_000_000 },
		});

		expect(events).to.have.length(1);
		expect(events[0]).to.include({
			percentage: 50,
			downloadedPercentage: 50,
			extractedPercentage: 50,
		});
	});

	it('does not report NaN when the total is 0', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.pullProgress((e) => events.push(e));

		onProgress({ id: 'Total', progressDetail: { current: 0, total: 0 } });

		expect(events).to.have.length(1);
		expect(events[0]).to.have.property('percentage', 0);
		expect(events[0].totalProgress).to.match(/ 0%$/);
	});

	it('reports 0 when the first total is omitted', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.pullProgress((e) => events.push(e));

		onProgress({ id: 'Total', progressDetail: { current: 5_000_000 } });

		expect(events).to.have.length(1);
		expect(events[0]).to.include({
			percentage: 0,
			downloadedPercentage: 0,
			extractedPercentage: 0,
		});
		expect(events[0].totalProgress).to.match(/ 0%$/);
	});

	it('keeps the last percentage while the total is 0 or omitted', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.pullProgress((e) => events.push(e));

		onProgress({
			id: 'Total',
			progressDetail: { current: 5_000_000, total: 10_000_000 },
		});
		onProgress({
			id: 'Total',
			progressDetail: { current: 6_000_000, total: 0 },
		});
		// The engine omits a total of 0
		onProgress({ id: 'Total', progressDetail: { current: 7_000_000 } });

		expect(events.map((e) => e.percentage)).to.deep.equal([50, 50, 50]);
		expect(events[2]).to.include({
			downloadedPercentage: 50,
			extractedPercentage: 50,
		});
	});

	it('caps the percentage at 100 when current exceeds the total', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.pullProgress((e) => events.push(e));

		onProgress({
			id: 'Total',
			progressDetail: { current: 12_000_000, total: 10_000_000 },
		});

		expect(events[0]).to.have.property('percentage', 100);
		expect(events[0].totalProgress).to.match(/ 100%$/);
	});
});

describe('pull progress with linked layers', () => {
	const getReporter = async () => {
		const mockDocker = { version: async () => ({ Version: '20.10.0' }) };
		const dp = new DockerProgress({ docker: mockDocker as any });
		return await dp['getProgressReporter']();
	};

	it('links a layer that has not been added yet', async () => {
		const reporter = await getReporter();
		const events: any[] = [];
		const onProgress = reporter.pullProgress((e) => events.push(e));

		onProgress({ status: 'Ready to download', id: 'layer' });
		onProgress({
			status: 'Extracting',
			id: 'layer',
			progressDetail: { current: 25_000_000, total: 50_000_000 },
		});

		expect(events).to.have.length(2);
		// The linked layer counts for both the download and extraction progress
		expect(events[1]).to.include({
			downloadedPercentage: 50,
			extractedPercentage: 50,
		});
	});
});
