//! JavaScript dates for session timestamps: `new Date(text).getTime()` on the ISO forms V8
//! accepts, and `toISOString`.
//!
//! V8 reads a year (`YYYY` or a sign and six digits), an optional month and day, an optional time
//! after `T` or a space (`HH:mm`, then optional `:ss` and fraction), and an optional `Z` or
//! `±HH:mm` offset. A day up to 31 rolls over into the next month (`2026-11-31` is December 1),
//! `24:00` is the next midnight, and a fraction keeps its first three digits. A date-time without
//! an offset is local time in V8; here it is UTC, since session files hold `toISOString` output.

use std::time::{SystemTime, UNIX_EPOCH};

const MS_PER_DAY: i64 = 86_400_000;
/// The largest time a `Date` holds (`TimeClip`).
const MAX_TIME: i64 = 8_640_000_000_000_000;

/// The current time in milliseconds (`Date.now()`).
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|time| time.as_millis() as i64)
        .unwrap_or_default()
}

/// Days from 1970-01-01 to a proleptic Gregorian date.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date of a day count from 1970-01-01.
fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// Reads `count` digits.
fn digits(bytes: &[u8], at: &mut usize, count: usize) -> Option<i64> {
    let slice = bytes.get(*at..*at + count)?;
    if !slice.iter().all(u8::is_ascii_digit) {
        return None;
    }
    *at += count;
    Some(
        slice
            .iter()
            .fold(0, |value, digit| value * 10 + i64::from(digit - b'0')),
    )
}

/// `new Date(text).getTime()`, or `None` for an invalid date.
pub fn parse_date(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    let mut at = 0;
    let year = match bytes.first()? {
        sign @ (b'+' | b'-') => {
            at = 1;
            let value = digits(bytes, &mut at, 6)?;
            if *sign == b'-' {
                if value == 0 {
                    return None;
                }
                -value
            } else {
                value
            }
        }
        _ => digits(bytes, &mut at, 4)?,
    };
    let mut month = 1;
    let mut day = 1;
    if bytes.get(at) == Some(&b'-') {
        at += 1;
        month = digits(bytes, &mut at, 2)?;
        if bytes.get(at) == Some(&b'-') {
            at += 1;
            day = digits(bytes, &mut at, 2)?;
        }
    }
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let (mut hour, mut minute, mut second, mut millisecond) = (0, 0, 0, 0);
    let mut offset_minutes = 0;
    if matches!(bytes.get(at), Some(b'T' | b' ')) {
        at += 1;
        hour = digits(bytes, &mut at, 2)?;
        if bytes.get(at) != Some(&b':') {
            return None;
        }
        at += 1;
        minute = digits(bytes, &mut at, 2)?;
        if bytes.get(at) == Some(&b':') {
            at += 1;
            second = digits(bytes, &mut at, 2)?;
            if bytes.get(at) == Some(&b'.') {
                at += 1;
                let start = at;
                while bytes.get(at).is_some_and(u8::is_ascii_digit) {
                    at += 1;
                }
                if at == start {
                    return None;
                }
                let fraction = &text[start..at.min(start + 3)];
                millisecond = format!("{fraction:0<3}").parse::<i64>().ok()?;
            }
        }
        match bytes.get(at) {
            Some(b'Z') => at += 1,
            Some(sign @ (b'+' | b'-')) => {
                let negative = *sign == b'-';
                at += 1;
                let hours = digits(bytes, &mut at, 2)?;
                if bytes.get(at) != Some(&b':') {
                    return None;
                }
                at += 1;
                let minutes = digits(bytes, &mut at, 2)?;
                if hours > 23 || minutes > 59 {
                    return None;
                }
                offset_minutes = (hours * 60 + minutes) * if negative { -1 } else { 1 };
            }
            _ => {}
        }
        let midnight = hour == 24 && minute == 0 && second == 0 && millisecond == 0;
        if !(hour < 24 || midnight) || minute > 59 || second > 59 {
            return None;
        }
    }
    if at != bytes.len() {
        return None;
    }
    let days = days_from_civil(year, month, 1) + day - 1;
    let time = days * MS_PER_DAY + ((hour * 60 + minute) * 60 + second) * 1000 + millisecond
        - offset_minutes * 60_000;
    (time.abs() <= MAX_TIME).then_some(time)
}

/// `new Date(time).toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`, with a sign and six digits for a
/// year outside 0 to 9999.
pub fn iso_string(time: i64) -> String {
    let days = time.div_euclid(MS_PER_DAY);
    let ms_of_day = time.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    let year_text = if (0..=9999).contains(&year) {
        format!("{year:04}")
    } else if year < 0 {
        format!("-{:06}", -year)
    } else {
        format!("+{year:06}")
    };
    format!(
        "{year_text}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        ms_of_day / 3_600_000,
        ms_of_day / 60_000 % 60,
        ms_of_day / 1000 % 60,
        ms_of_day % 1000
    )
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    iso_string(now_ms())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_what_it_reads() {
        for time in [
            0,
            -1,
            1_795_171_278_123,
            -62_198_755_200_000,
            317_364_691_278_000,
        ] {
            assert_eq!(parse_date(&iso_string(time)), Some(time));
        }
        assert_eq!(iso_string(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso_string(-1), "1969-12-31T23:59:59.999Z");
    }
}
