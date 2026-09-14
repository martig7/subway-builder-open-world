# Native save change measurements

Offline diagnostic for completed `.metro` snapshots. It does not connect to the
game, change a save, implement an incremental writer, or install a mod. See the
[measured Japan results](../../../../docs/prototypes/incremental-save-measurements.md).

Run from the repository root with .NET 8:

```powershell
$env:DOTNET_GCHeapHardLimit='0x10000000'
dotnet run --project open-world-platform/native/tools/OpenWorld.SaveMeasurements -c Release -- self-test
$measure='.\open-world-platform\native\tools\OpenWorld.SaveMeasurements\bin\Release\net8.0\open-world-save-measurements.exe'
& $measure profile '.analysis\before.metro' '.analysis\before.json'
& $measure profile '.analysis\after.metro' '.analysis\after.json'
& $measure compare '.analysis\before.json' '.analysis\after.json' '.analysis\comparison.json'
```

Copy completed saves into `.analysis` first, before the game's autosave rotation
removes them. Choose new output names: existing reports are never overwritten.
Check each exit code. A failed profile can leave a partial `.rows.jsonl`; only
a successful summary JSON marks a complete profile. The rows file must stay at
the absolute `recordsPath` stored in that summary.

The profile streams gzip and hashes raw UTF-8 values with SHA-256, retaining only
active scopes. It reports native header metadata and fingerprints for save
sections, array records and individual train fields. Section sizes overlap their
children; record sizes overlap train fields. **Do not sum every group or section.**

The comparison matches object `id`, pop tuple ID, or the completed-commute
`p`/`js`/`o` identity. Other arrays use position. `movedRecords` identifies reordered
stable IDs. `keysUnique: false` makes a group's reuse estimate unsuitable; use its
whole section instead. Positional comparison can overstate change after inserts
or reordering. Primitive IDs are rendered as text, so mixed-type IDs such as `1`
and `"1"` are not distinguished. Current measured save groups have consistent,
unique identities.

`replacementBytes` counts raw values of changed or added records. Deletions and
order are counted separately. It is not a serialized patch size or a heap estimate:
it excludes property names, separators, deletion/order instructions, and snapshot
envelopes. Train fields permit a finer estimate without duplicating the whole
train. Raw hashes also treat field order or formatting changes as changes; this is
not semantic deduplication of repeated timetable or route geometry.

Comparisons reject differing cities, sessions, measurement versions, and truncated
record profiles. Changing Tile View needs an explicit new baseline even if World
identity stays the same. The profiler checks METR payload boundaries and gzip/JSON
parsing; it is not a native save schema validator or a restore test.

Memory safeguards: 64 KiB streaming buffer, 8 MiB maximum scalar token, 2 GiB
uncompressed input, JSON depth 128, at most 500,000 record fingerprints and 100,000
train field fingerprints on disk. A larger record count sets `truncated`, leaving
section measurements usable. Comparison rereads fingerprints in eight identity
partitions to keep both old-record and new-key indexes small. The 256 MiB managed
heap cap above is a fail-stop bound, not a total process RSS guarantee. Real Japan
captures peaked at about 48 MiB RSS while profiling and 90 MiB while comparing.

Self-tests cover byte ranges across small buffer/UTF-8 boundaries, nested values,
stable and late IDs, train fields, modifications, insertions, deletions, reordering,
duplicate IDs, removed sections, partitioned comparison, and truncated JSON.
