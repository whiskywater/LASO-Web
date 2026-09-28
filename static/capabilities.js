(function (root, factory) {
  const model = factory();
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.LasoCapabilities = model;
})(globalThis, function () {
  "use strict";
  const capabilityName = /^[a-z][a-z0-9]*(?:[._][a-z0-9]+)*$/;

  function parse(value) {
    const advertised = value?.advertised === true && Array.isArray(value.capabilities);
    const capabilities = advertised
      ? [...new Set(value.capabilities.filter(name => typeof name === "string" && capabilityName.test(name)))]
      : [];
    return Object.freeze({
      advertised,
      capabilities: Object.freeze(capabilities),
      supports(name) { return advertised ? capabilities.includes(name) : null; }
    });
  }

  async function load() {
    const response = await fetch("/api/laso/capabilities", { cache: "no-store" });
    if (!response.ok) throw new Error(`Capability discovery failed (${response.status}).`);
    return parse(await response.json());
  }

  return { parse, load };
});
