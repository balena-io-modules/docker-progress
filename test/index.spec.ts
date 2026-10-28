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
