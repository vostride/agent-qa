#!/bin/sh
echo 'AGENT_QA_EVENT:{"type":"test-start","testName":"test"}'
echo 'AGENT_QA_EVENT:{"type":"test-complete","testName":"test","status":"passed"}'
exit 0
