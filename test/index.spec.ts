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
