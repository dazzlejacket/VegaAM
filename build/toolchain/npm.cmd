@echo off
rem Minimal npm stand-in for build machines without a Node/npm installation.
rem See build/toolchain/npm-shim.cjs for what it does and why it is safe here.
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\..\node_modules\electron\dist\electron.exe" "%~dp0npm-shim.cjs" %*
