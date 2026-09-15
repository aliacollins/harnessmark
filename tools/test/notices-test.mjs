import assert from "node:assert/strict"
import fs from "node:fs"
import {REPOS} from "../../harness/registry.mjs"
import {NOTICES_PATH, licenseFile, renderNotices} from "../notices.mjs"

// Every active repo ships its upstream license verbatim and appears in the notices.
for (const r of Object.values(REPOS).filter(r => r.status === "active")) {
	assert.ok(fs.existsSync(licenseFile(r)), `${r.name}: third_party/${r.name}/LICENSE exists`)
	assert.ok(renderNotices().includes(`### ${r.name}`), `${r.name}: has a notices section`)
}

// The checked-in file matches the registry; regenerate with `node tools/notices.mjs`.
assert.equal(fs.readFileSync(NOTICES_PATH, "utf8"), renderNotices(), "THIRD_PARTY_NOTICES.md is current")

// An active repo without a license file is a hard error, never a silent omission.
assert.throws(
	() => renderNotices({ghost: {name: "ghost", status: "active", url: "https://example.invalid/ghost", license: "MIT"}}),
	/third_party\/ghost\/LICENSE is missing/
)

console.log("notices-test: ok")
