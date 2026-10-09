//! Dates and instants as the contract writes them (`YYYY-MM-DD`, RFC 3339).
//!
//! Both connectors and the pipeline's evaluation context need the same
//! formatting; a date crate for four functions would be the larger
//! dependency.

use std::time::{SystemTime, UNIX_EPOCH};

/// Days since 1970-01-01 → `(year, month, day)` (Hinnant's civil algorithm).
fn civil(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

/// `YYYY-MM-DD` for a day count since the epoch.
pub fn date(days: i64) -> String {
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

/// RFC 3339 UTC for seconds plus nanoseconds since the epoch; the fraction is
/// omitted when zero.
pub fn timestamp(secs: i64, nanos: u32) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    let rem = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (rem / 3600, rem % 3600 / 60, rem % 60);
    let fraction = if nanos == 0 {
        String::new()
    } else {
        format!(".{nanos:09}").trim_end_matches('0').to_owned()
    };
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}{fraction}Z")
}

/// The current instant, whole seconds.
pub fn now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    timestamp(i64::try_from(secs).unwrap_or(0), 0)
}
