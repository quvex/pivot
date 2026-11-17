// Stand-in for node:url in the browser bundle.
export const fileURLToPath = (u) => new URL(String(u)).pathname;
export default { fileURLToPath };
