"use strict";

const { validateNormalizedActivity } = require("../activity-validation");

const DEFAULT_TIMEOUT_MS = 15000;

function unfoldIcsLines(text) {
  return String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n")
    .split("\n")
    .reduce((lines, line) => {
      if (/^[ \t]/.test(line) && lines.length) lines[lines.length - 1] += line.slice(1);
      else lines.push(line);
      return lines;
    }, []);
}

function unescapeIcsText(value) {
  return String(value || "")
    .replace(/\\[nN]/g, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function parseContentLine(line) {
  let separator = -1;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') quoted = !quoted;
    if (line[index] === ":" && !quoted) { separator = index; break; }
  }
  if (separator < 1) return null;
  const parts = line.slice(0, separator).split(";");
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const part of parts) {
    const equal = part.indexOf("=");
    if (equal < 1) continue;
    params[part.slice(0, equal).toUpperCase()] = part.slice(equal + 1).replace(/^"|"$/g, "");
  }
  return { name, params, value: line.slice(separator + 1) };
}

function parseIcsCalendar(text) {
  const events = [];
  const calendar = {};
  let event = null;
  for (const line of unfoldIcsLines(text)) {
    if (line === "BEGIN:VEVENT") { event = {}; continue; }
    if (line === "END:VEVENT") { if (event) events.push(event); event = null; continue; }
    const property = parseContentLine(line);
    if (!property) continue;
    const target = event || calendar;
    if (!target[property.name]) target[property.name] = [];
    target[property.name].push(property);
  }
  return { calendar, events };
}

function firstProperty(component, name) {
  return component && Array.isArray(component[name]) ? component[name][0] : null;
}

function textProperty(component, name) {
  const property = firstProperty(component, name);
  return property ? unescapeIcsText(property.value) : null;
}

function timezoneOffsetMs(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - date.getTime();
}

function localDateTimeToIso(parts, timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(new Date(0));
  } catch (_) {
    return null;
  }
  const guessedUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  let instant = guessedUtc - timezoneOffsetMs(new Date(guessedUtc), timeZone);
  instant = guessedUtc - timezoneOffsetMs(new Date(instant), timeZone);
  return new Date(instant).toISOString();
}

function parseIcsDate(property, fallbackTimezone) {
  if (!property) return { iso: null, timezone: null };
  const value = String(property.value || "").trim();
  const timeZone = property.params.TZID || fallbackTimezone || null;
  let match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (match) {
    return {
      iso: new Date(Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6])).toISOString(),
      timezone: timeZone
    };
  }
  match = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
  if (match && timeZone) {
    return {
      iso: localDateTimeToIso({ year: +match[1], month: +match[2], day: +match[3], hour: +match[4], minute: +match[5], second: +match[6] }, timeZone),
      timezone: timeZone
    };
  }
  match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (match && timeZone) {
    return {
      iso: localDateTimeToIso({ year: +match[1], month: +match[2], day: +match[3], hour: 0, minute: 0, second: 0 }, timeZone),
      timezone: timeZone
    };
  }
  return { iso: null, timezone: timeZone };
}

function parseGeo(value) {
  const match = String(value || "").match(/^\s*(-?\d+(?:\.\d+)?)\s*[;,]\s*(-?\d+(?:\.\d+)?)\s*$/);
  return match ? { latitude: Number(match[1]), longitude: Number(match[2]) } : { latitude: null, longitude: null };
}

function parseLocation(value) {
  const location = unescapeIcsText(value);
  if (!location) return { venueName: null, address: null, postalCode: null, city: null };
  const separator = location.indexOf(" - ");
  const venueName = separator >= 0 ? location.slice(0, separator).trim() || null : null;
  const remainder = separator >= 0 ? location.slice(separator + 3).trim() : location;
  const postalMatch = remainder.match(/\b(\d{5})\s+([^,]+?)\s*$/i);
  return {
    venueName,
    address: remainder || null,
    postalCode: postalMatch ? postalMatch[1] : null,
    city: postalMatch ? postalMatch[2].trim() : (venueName ? null : remainder)
  };
}

function organizerFromProperty(property) {
  if (!property) return [];
  const name = unescapeIcsText(property.params.CN || "") || null;
  const rawUrl = String(property.value || "").trim();
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : null;
  return name || url ? [{ name, url }] : [];
}

function pickOnlineUrl(event) {
  for (const name of ["CONFERENCE", "X-ONLINE-URL", "X-OPENAGENDA-ONLINE-ACCESS-LINK"]) {
    const value = textProperty(event, name);
    if (value) return value;
  }
  return null;
}

function mapIcalLifecycleStatus(value) {
  const sourceStatus = validUpper(value);
  const statuses = {
    CONFIRMED: "scheduled",
    TENTATIVE: "tentative",
    CANCELLED: "cancelled",
    POSTPONED: "postponed"
  };
  return { lifecycleStatus: statuses[sourceStatus] || "scheduled", sourceStatus, recognized: !sourceStatus || Boolean(statuses[sourceStatus]) };
}

function validUpper(value) {
  const normalized = String(value || "").trim().toUpperCase();
  return normalized || null;
}

function mapOpenAgendaIcalEvent(event, options = {}) {
  const sourceName = options.sourceName || "OpenAgenda";
  const sourceUrl = options.sourceUrl || null;
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const calendarTimezone = options.defaultTimezone || null;
  const starts = parseIcsDate(firstProperty(event, "DTSTART"), calendarTimezone);
  const ends = parseIcsDate(firstProperty(event, "DTEND"), starts.timezone || calendarTimezone);
  const locationText = textProperty(event, "LOCATION");
  const location = parseLocation(locationText);
  const onlineUrl = pickOnlineUrl(event);
  const originalEventUrl = textProperty(event, "URL");
  const uid = textProperty(event, "UID");
  const geo = parseGeo(textProperty(event, "GEO"));
  const hasPhysical = Boolean(location.venueName || location.address || location.city);
  const locationType = hasPhysical && onlineUrl ? "hybrid" : onlineUrl ? "online" : hasPhysical ? "physical" : null;
  const categories = textProperty(event, "CATEGORIES");
  const lifecycle = mapIcalLifecycleStatus(textProperty(event, "STATUS"));
  const evidence = [];
  if (locationText) evidence.push({ field: "address", sourceValue: locationText, provenanceIndex: 0 });
  if (firstProperty(event, "DTSTART")) evidence.push({ field: "startsAt", sourceValue: firstProperty(event, "DTSTART").value, provenanceIndex: 0 });
  if (lifecycle.sourceStatus) evidence.push({ field: "lifecycleStatus", sourceValue: lifecycle.sourceStatus, provenanceIndex: 0 });

  return {
    title: textProperty(event, "SUMMARY"),
    description: textProperty(event, "DESCRIPTION"),
    startsAt: starts.iso,
    endsAt: ends.iso,
    timezone: starts.timezone,
    lifecycleStatus: lifecycle.lifecycleStatus,
    locationType,
    venueName: location.venueName,
    address: location.address,
    postalCode: location.postalCode,
    city: location.city,
    country: options.country || null,
    latitude: geo.latitude,
    longitude: geo.longitude,
    onlineUrl,
    organizers: organizerFromProperty(firstProperty(event, "ORGANIZER")),
    category: null,
    subcategory: null,
    tags: categories ? categories.split(",").map(unescapeIcsText) : [],
    provenances: [{ sourceType: "ical", sourceName, sourceUrl, originalEventUrl, externalId: uid, fetchedAt }],
    externalIds: uid ? [{ system: "ical", value: uid }] : [],
    imageUrl: textProperty(event, "IMAGE") || null,
    bookingUrl: null,
    admissionType: "unknown",
    confidence: 0.9,
    fieldConfidence: {
      ...(locationText ? { venueName: location.venueName ? 0.8 : 0.7, city: location.city ? 0.75 : 0.7 } : {}),
      ...(!lifecycle.recognized ? { lifecycleStatus: 0.5 } : {})
    },
    evidence
  };
}

function convertOpenAgendaIcal(text, options = {}) {
  const parsed = parseIcsCalendar(text);
  const defaultTimezone = options.defaultTimezone || textProperty(parsed.calendar, "X-WR-TIMEZONE") || null;
  const events = Number.isInteger(options.limit) && options.limit >= 0
    ? parsed.events.slice(0, options.limit)
    : parsed.events;
  return events.map((event, index) => {
    try {
      const activity = mapOpenAgendaIcalEvent(event, { ...options, defaultTimezone });
      return { index, activity, validation: validateNormalizedActivity(activity), error: null };
    } catch (error) {
      return { index, activity: null, validation: null, error: error.message };
    }
  });
}

async function fetchOpenAgendaIcal(options = {}) {
  if (!options.sourceUrl) throw new Error("sourceUrl est obligatoire");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(options.sourceUrl, {
      headers: { "Accept": "text/calendar", "User-Agent": options.userAgent || "MnoriaBotSortir/1.0" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`OpenAgenda iCal a répondu HTTP ${response.status}`);
    const text = await response.text();
    return convertOpenAgendaIcal(text, { ...options, fetchedAt: options.fetchedAt || new Date().toISOString() });
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  parseIcsCalendar,
  parseIcsDate,
  parseLocation,
  mapIcalLifecycleStatus,
  mapOpenAgendaIcalEvent,
  convertOpenAgendaIcal,
  fetchOpenAgendaIcal
};
