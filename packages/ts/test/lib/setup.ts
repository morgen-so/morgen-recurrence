// rrule.js's own tests expect its former Intl-based TZID conversion.
import { setTimeZoneAdapter } from '../../src/timezone'
import { rrulejsIntlAdapter } from './intlAdapter'

setTimeZoneAdapter(rrulejsIntlAdapter)
