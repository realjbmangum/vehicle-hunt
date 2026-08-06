-- Sample listings for local dev — illustrative data, not real
DELETE FROM listings;
INSERT INTO listings
  (year, trim, price, mileage, vin, color, drivetrain, bed_size, cab_type,
   dealer_name, dealer_location, listing_url, source, sender_email,
   ingested_at, last_seen_at, alert_status, status, deal_score, deal_grade)
VALUES
  (2022, 'TRD Off-Road', 33900, 28450, '3TYCZ5AN8NT012345', 'Magnetic Gray', '4WD', 'Short', 'Double Cab',
   'Example Toyota North', 'Springfield, IL', 'https://example.com/listing/1', 'carvana', 'alerts@carvana.com',
   datetime('now', '-2 days'), datetime('now'), 'pending', 'watching', 87, 'A'),
  (2021, 'SR5', 30990, 41200, '3TYAX5GN4MT001234', 'Quicksand', '4WD', 'Short', 'Double Cab',
   'Carvana', 'Delivered', 'https://example.com/listing/2', 'carvana', 'alerts@carvana.com',
   datetime('now', '-1 days'), datetime('now'), 'pending', 'watching', 76, 'B'),
  (2023, 'TRD Sport', 36400, 19800, '3TYCZ5AN9PT054321', 'Cement', '4WD', 'Short', 'Double Cab',
   'Example Motors', 'Riverton, IL', 'https://example.com/listing/3', 'truecar', 'alerts@truecar.com',
   datetime('now', '-1 days'), datetime('now'), 'pending', 'watching', 73, 'B'),
  (2020, 'SR5', 28499, 47100, '3TYAX5GN1LT012009', 'Cement', '4WD', 'Short', 'Double Cab',
   'CarMax Matthews', 'Matthews, NC', 'https://example.com/listing/4', 'carmax', 'noreply@carmax.com',
   datetime('now', '-3 days'), datetime('now', '-1 hours'), 'digested', 'contacted', 81, 'A'),
  (2022, 'SR5', 34200, 38700, '3TYAX5GN5NT034567', 'Super White', '4WD', 'Short', 'Double Cab',
   'Scott Clark Toyota', 'Matthews, NC', 'https://example.com/listing/5', 'autotempest', 'alerts@autotempest.com',
   datetime('now', '-4 days'), datetime('now', '-2 hours'), 'pending', 'scheduled', 79, 'B'),
  (2019, 'TRD Off Road', 31891, 79374, '3TMCZ5AN0KM213456', 'Magnetic Gray', '4WD', 'Short', 'Double Cab',
   'Cloninger Ford Toyota', 'Salisbury, NC', 'https://example.com/listing/6', 'cargurus', 'noreply@cargurus.com',
   datetime('now', '-5 days'), datetime('now', '-3 days'), 'digested', 'pass', 58, 'C'),
  (2017, 'SR5', 22435, 83715, '5TFCZ5AN3HX098765', 'Silver', '2WD', 'Short', 'Double Cab',
   'Honda of Salisbury', 'Salisbury, NC', 'https://example.com/listing/7', 'cars', 'alerts@cars.com',
   datetime('now', '-6 days'), datetime('now', '-3 days'), 'digested', 'pass', 41, 'D');
