const path = require('path');

const port = String(process.argv[2] || process.env.PORT || '3000');
process.env.PORT = port;
process.chdir(path.join(__dirname, '..'));
require('../server/index.js');
