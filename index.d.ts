import * as Promise from 'bluebird';

declare module 'docker-progress' {

	type ProgressCallback = (progressObj: any) => void;

	class DockerProgress {

		public constructor(opts?: any);

		public aggregateProgress(count: number, onProgress: ProgressCallback): ProgressCallback[];

		// This is actually a handle to a docker-toolbelt instantiation, but that
		// module does not have any typings as of yet. Access is required to the
		// modem property by callers, as this is the method of aiming
		// docker-progress at different docker daemons.
		public docker: { modem: any };

		public pull(
			image: string,
			onProgress: ProgressCallback,
			options: any,
			callback?: ((err: Error, data: any) => void),
		): Promise<string | null>;

		public push(
			image: string,
			onProgress: ProgressCallback,
			options: any,
			callback?: ((err: Error, data: any) => void),
		): Promise<string | null>;

	}
}
