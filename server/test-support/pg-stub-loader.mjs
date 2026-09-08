const pgStubUrl = new URL("./pg-stub.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "pg") {
    return {
      url: pgStubUrl,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
