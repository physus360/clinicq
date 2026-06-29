-- Add consultation_tier to staff table
ALTER TABLE staff ADD COLUMN IF NOT EXISTS consultation_tier TEXT;

-- Update existing doctor records with their tiers from doctor_rates
UPDATE staff s
SET consultation_tier = dr.tier
FROM doctor_rates dr
WHERE dr.staff_id = s.id;
