// Test hook for REF_FETCH_MODULE: forwards to whatever the test installed on
// globalThis.__refFakeFetch so one process can script many scenarios.
export default function fakeFetch(url, init) {
	if (typeof globalThis.__refFakeFetch !== "function") throw new Error("fake fetch not installed")
	return globalThis.__refFakeFetch(url, init)
}
