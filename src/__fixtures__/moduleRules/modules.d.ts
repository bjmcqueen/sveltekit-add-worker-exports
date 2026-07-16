declare module '*.sql' {
	const contents: string;
	export default contents;
}

declare module '*.bin' {
	const contents: ArrayBuffer;
	export default contents;
}

declare module '*.wasm' {
	const module: WebAssembly.Module;
	export default module;
}
