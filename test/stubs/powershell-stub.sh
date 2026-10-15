#!/usr/bin/env bash
# Stands in for powershell.exe in the tests: speaks the print worker protocol of
# services/PrinterService.js (READY, then "OK <id>" per JSON line) and logs each request
# to $RESTIFY_PRINT_STUB_LOG so the test can see what the image engine printed.
echo READY
while IFS= read -r line; do
    [ -z "$line" ] && continue
    printf '%s\n' "$line" >> "${RESTIFY_PRINT_STUB_LOG:-/dev/null}"
    id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p')
    echo "OK $id"
done
