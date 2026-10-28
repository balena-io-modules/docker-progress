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
