// Launch Electron with ELECTRON_RUN_AS_NODE removed from the environment.
// If the var is set anywhere in the user's shell/profile, Electron will run in plain Node
// mode and `require('electron')` returns the binary path instead of the API, crashing any
// real Electron app. (Copied verbatim from Terminator's scripts/run-electron.js.)
const { spawn } = require('child_process');
const electron = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code ?? 1));
