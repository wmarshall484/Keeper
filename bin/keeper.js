#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');

// Get the directory argument from command line
const args = process.argv.slice(2);

// Path to the main Electron entry point
const mainScript = path.join(__dirname, '..', 'main.js');

// Launch Electron with the main script and user arguments
const electron = require('electron');

const child = spawn(electron, [mainScript, ...args], {
  stdio: 'inherit',
  env: process.env
});

child.on('close', (code) => {
  process.exit(code);
});

child.on('error', (err) => {
  console.error('Failed to start Keeper:', err);
  process.exit(1);
});
