// schedule-cron-2-minutes.js
const { DateTime } = require("luxon");
const { testServicesCron } = require("./crons");

// Calculate 2 minutes from now
const now = DateTime.now();
const startTime = now.plus({ minutes: 2 }).toISO();

// Replace "some-date-id" with your actual EventDate ID
const dateId = "da7a3d0e-04da-469c-881f-77b08f1bb85e"; // Example dateId

console.log(`Scheduling cron jobs for startTime: ${startTime}`);

// Call testServicesCron with the calculated startTime
testServicesCron(startTime, dateId).catch((err) => {
  console.error(err);
});
