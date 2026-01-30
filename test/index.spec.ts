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
