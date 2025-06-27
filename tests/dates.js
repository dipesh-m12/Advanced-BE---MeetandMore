const { DateTime } = require("luxon");

const getBookingEventDate = (timezone, utcTime) => {
  // Convert UTC time to local timezone
  const now = DateTime.fromJSDate(utcTime, { zone: "utc" }).setZone(timezone);
  const today = now.startOf("day");

  // Check if today is Saturday and before noon
  const isSaturday = now.weekday === 6;
  const noonDeadline = today.set({ hour: 12, minute: 0, second: 0 });

  if (isSaturday && now <= noonDeadline) {
    // Return today's event at 8 PM local time
    return today
      .set({ hour: 20, minute: 0, second: 0, millisecond: 0 })
      .toISO();
  }

  // Find next Saturday
  let nextSat = today.plus({ days: (6 - today.weekday + 7) % 7 || 7 });
  // Return next Saturday's event at 8 PM local time
  return nextSat
    .set({ hour: 20, minute: 0, second: 0, millisecond: 0 })
    .toISO();
};

module.exports = { getBookingEventDate };
