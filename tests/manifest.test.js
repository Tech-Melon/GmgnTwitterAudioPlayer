const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'manifest.json'), 'utf8'));

test('manifest release version and permissions are production-safe', () => {
    assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
    assert.equal(manifest.manifest_version, 3);
    assert.equal(manifest.host_permissions.includes('http://127.0.0.1:37921/*'), false);
    assert.equal(manifest.optional_host_permissions.includes('http://127.0.0.1:37921/*'), true);
});

test('every manifest entry point and declared resource exists', () => {
    const files = [
        manifest.background.service_worker,
        manifest.action.default_popup,
        ...manifest.content_scripts.flatMap((script) => script.js),
        ...manifest.web_accessible_resources.flatMap((group) => group.resources)
    ];
    for (const file of new Set(files)) {
        assert.equal(fs.existsSync(path.join(projectRoot, file)), true, `missing manifest file: ${file}`);
    }
});
