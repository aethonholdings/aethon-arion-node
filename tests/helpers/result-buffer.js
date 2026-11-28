// keep the tests' result buffer out of the home directory
const fs = require("fs");
const os = require("os");
const path = require("path");
process.env.ARION_NODE_RESULTS = fs.mkdtempSync(path.join(os.tmpdir(), "arion-results-"));
