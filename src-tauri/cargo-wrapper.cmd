@echo off
setlocal
set SCRIPT_DIR=%~dp0
cargo --manifest-path "%SCRIPT_DIR%Cargo.toml" %*
