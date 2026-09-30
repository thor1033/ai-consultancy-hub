# The Teams app package

Three files make the app Teams installs: this `manifest.json`, a 192×192
`color.png` and a 32×32 transparent `outline.png`. Zip the three at the top
level (not the folder) and upload the zip.

Before zipping, replace **both** `REPLACE_WITH_BOT_APP_ID` values with the
Microsoft App ID of the Azure Bot resource — `id` and `bots[0].botId` are the
same GUID, and Teams rejects the package if they disagree.

`scopes` deliberately includes `team`, which is what "lives in the channel"
means: the bot is installed to a team and answers when mentioned there. In a
channel a bot only receives messages that @mention it, which is the behaviour
you want — nobody's side conversation reaches the hub.

The icons are not in this repo. Any 192×192 PNG and a 32×32 white-on-transparent
outline will do; Teams only checks the sizes.

Full setup, including the Azure Bot resource and the messaging endpoint, is in
[docs/teams.md](../../../docs/teams.md).
