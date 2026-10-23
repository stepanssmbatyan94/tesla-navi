---
name: add-voice-phrase
description: >
  Add or change a Tesla Navi voice prompt in all three languages: I18N text for
  ru/en (neural Edge voices) plus prerecorded Armenian clips for Gor and Suzie,
  the server mapping in getArmenianAudio and the generator script. Use when a
  new spoken prompt is added, a prompt says the wrong thing, or Armenian plays
  the wrong clip / the greeting ("добавь фразу", "озвучка", "голос говорит не то").
---

# add-voice-phrase

Follow `docs/playbooks/add-voice-phrase.md` (canonical, shared with every agent). Keep the one-off generator script in the scratchpad, never in the repo; don't send phrases to armtts.online unless the user asks. Verify the mapping with the playbook's curl/md5 loop for both voices and commit the `.mp3` files together with the mapping.
