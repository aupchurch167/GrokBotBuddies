-- Bot ids are ordered in the app with JavaScript string comparison (code-unit order).
-- Compare with the "C" collation so the CHECK agrees with the app regardless of the
-- database's default collation (e.g. en_US.utf8 sorts 'bot_a' before 'bot_P').
ALTER TABLE "Connection" DROP CONSTRAINT "Connection_order_chk";
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_order_chk"
  CHECK ("botAId" COLLATE "C" < "botBId" COLLATE "C");
