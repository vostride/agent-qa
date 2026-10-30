---
schemaVersion: 2
id: "procedure-flow-t-posing-clock-inject-pill-adds-i-29ff61a3638ac355"
kind: "procedure"
anchors: [{"raw":{"t":"flow","name":"t_posing-clock-inject-pill-adds-ima-rename-video-emu-fault"},"normalized":{"t":"flow","name":"t_posing-clock-inject-pill-adds-ima-rename-video-emu-fault"}},{"raw":{"t":"page","route":"http://127.0.0.1:8931/form.html"},"normalized":{"t":"page","route":"http://127.0.0.1:8931/form.html"}}]
scope: {"tier":"product","key":"local-form"}
createdAtOrdinal: 32
originClass: "agent-verified"
evidenceIncomplete: false
---

## Summary

Procedure t_posing-clock-inject-pill-adds-ima-rename-video-emu-fault (2 steps)

## Detail

```json agent-qa-procedure
{"parameters":[{"name":"PROBE_USER","required":true,"type":"string"}],"schemaVersion":2,"steps":[{"action":{"targets":{"ref":{"nameNormalized":"username","ordinal":0,"role":"textbox"}},"type":"fill","values":{"clearMode":"replace","elementDescription":"Username field","submit":false,"text":{"param":"PROBE_USER"}}},"guard":{"pageAnchor":{"route":"http://127.0.0.1:8931/form.html","t":"page"},"target":{"nameNormalized":"username","ordinal":0,"role":"textbox"}},"instruction":"Type \"<EMAIL_0>\" into the Username field"},{"action":{"targets":{"ref":{"nameNormalized":"submit","ordinal":0,"role":"button"}},"type":"click","values":{"clickDelay":0,"desiredState":"selected","elementDescription":"Submit button"}},"guard":{"pageAnchor":{"route":"http://127.0.0.1:8931/form.html","t":"page"},"target":{"nameNormalized":"submit","ordinal":0,"role":"button"}},"instruction":"Click the Submit button"}],"successAssertion":"The visible page says \"Received!\"."}
```
