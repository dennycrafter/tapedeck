-- T15: songs uploaded from the owner's own device (mp3, m4a, wav, flac).
-- source = 'upload', source_id = a fingerprint of the file (so the same file
-- uploaded twice is "Already in your library"), source_url = ''. They are
-- inserted ready, with storage_key pointing at the uploaded file
-- (tracks/<id>.<ext>), so the PC downloader never claims them.
alter table tracks drop constraint if exists tracks_source_check;
alter table tracks add constraint tracks_source_check
  check (source in ('youtube','soundcloud','catalog','upload'));
