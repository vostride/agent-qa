#!/bin/sh
echo 'AGENT_QA_EVENT:{"type":"test-start","testName":"test"}'
while true; do
  echo 'AGENT_QA_EVENT:{"type":"heartbeat"}'
  sleep 2
done
