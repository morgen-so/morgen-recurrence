/// RFC 5545 recurrence rule expansion on floating (wall-clock) times, and
/// conversion to and from JSCalendar (RFC 8984).
///
/// A port of the rrule.js 2.8.0 expansion core with Morgen's fixes; see
/// `src/rrule.dart` for the differences from rrule.js.
library;

export 'src/jscalendar.dart'
    show
        ICalDateForm,
        ICalRecurrenceDates,
        ToEventTime,
        ToUtc,
        jsCalendarToRRule,
        recurrenceOverridesFromICal,
        recurrenceOverridesToICal,
        rruleMeaningInJsCalendar,
        rruleToJsCalendar;
export 'src/rrule.dart';
