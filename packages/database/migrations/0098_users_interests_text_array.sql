ALTER TABLE "users" ALTER COLUMN "interests" TYPE text[] USING "interests"::text[];
