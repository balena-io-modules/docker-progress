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
