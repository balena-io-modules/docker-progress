import * as Promise from 'bluebird';

declare module 'docker-progress' {

	type ProgressCallback = (progressObj: any) => void;

	class DockerProgress {

		public constructor(opts?: any);

		public aggregateProgress(count: number, onProgress: ProgressCallback): ProgressCallback[];

		public pull(
			image: string,
			onProgress: ProgressCallback,
			options: any,
			callback?: ((err: Error, data: any) => void),
		): Promise<any>;

		public push(
			image: string,
			onProgress: ProgressCallback,
			options: any,
			callback?: ((err: Error, data: any) => void),
		): Promise<any>;

	}
}
