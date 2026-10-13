/**
 * ISO 3166-1 alpha-2 → region name of the ECharts 4.9 `world.json` GeoJSON
 * (`echarts/map/json/world.json`), the map the `map` chart draws on.
 *
 * ECharts 5 ships no maps, so the host registers the GeoJSON itself
 * (`echarts.registerMap('world', geoJson)`) — the web page fetches that file
 * from a CDN. A host registering another GeoJSON adapts these names or
 * pins `viz.echarts.series` itself. A code with no entry is drawn under its
 * own code and simply finds no region.
 */
export const WORLD_MAP = 'world';

const NAMES = `AF Afghanistan|AL Albania|DZ Algeria|AS American Samoa|AD Andorra|AO Angola|AG Antigua and Barb.|AR Argentina|AM Armenia|AU Australia|AT Austria|AZ Azerbaijan|BS Bahamas|BH Bahrain|BD Bangladesh|BB Barbados|BY Belarus|BE Belgium|BZ Belize|BJ Benin|BM Bermuda|BT Bhutan|BO Bolivia|BA Bosnia and Herz.|BW Botswana|BR Brazil|BN Brunei|BG Bulgaria|BF Burkina Faso|BI Burundi|KH Cambodia|CM Cameroon|CA Canada|CV Cape Verde|KY Cayman Is.|CF Central African Rep.|TD Chad|CL Chile|CN China|CO Colombia|KM Comoros|CG Congo|CD Dem. Rep. Congo|CR Costa Rica|CI Côte d'Ivoire|HR Croatia|CU Cuba|CW Curaçao|CY Cyprus|CZ Czech Rep.|DK Denmark|DJ Djibouti|DM Dominica|DO Dominican Rep.|EC Ecuador|EG Egypt|SV El Salvador|GQ Eq. Guinea|ER Eritrea|EE Estonia|ET Ethiopia|FK Falkland Is.|FO Faeroe Is.|FJ Fiji|FI Finland|FR France|PF Fr. Polynesia|GA Gabon|GM Gambia|GE Georgia|DE Germany|GH Ghana|GR Greece|GL Greenland|GD Grenada|GU Guam|GT Guatemala|GN Guinea|GW Guinea-Bissau|GY Guyana|HT Haiti|HN Honduras|HU Hungary|IS Iceland|IN India|ID Indonesia|IR Iran|IQ Iraq|IE Ireland|IM Isle of Man|IL Israel|IT Italy|JM Jamaica|JP Japan|JE Jersey|JO Jordan|KZ Kazakhstan|KE Kenya|KI Kiribati|KP Dem. Rep. Korea|KR Korea|KW Kuwait|KG Kyrgyzstan|LA Lao PDR|LV Latvia|LB Lebanon|LS Lesotho|LR Liberia|LY Libya|LI Liechtenstein|LT Lithuania|LU Luxembourg|MK Macedonia|MG Madagascar|MW Malawi|MY Malaysia|ML Mali|MT Malta|MR Mauritania|MU Mauritius|MX Mexico|FM Micronesia|MD Moldova|MN Mongolia|ME Montenegro|MS Montserrat|MA Morocco|MZ Mozambique|MM Myanmar|NA Namibia|NP Nepal|NL Netherlands|NC New Caledonia|NZ New Zealand|NI Nicaragua|NE Niger|NG Nigeria|NU Niue|MP N. Mariana Is.|NO Norway|OM Oman|PK Pakistan|PW Palau|PS Palestine|PA Panama|PG Papua New Guinea|PY Paraguay|PE Peru|PH Philippines|PL Poland|PT Portugal|PR Puerto Rico|QA Qatar|RO Romania|RU Russia|RW Rwanda|SH Saint Helena|LC Saint Lucia|PM St. Pierre and Miquelon|VC St. Vin. and Gren.|WS Samoa|ST São Tomé and Principe|SA Saudi Arabia|SN Senegal|RS Serbia|SC Seychelles|SL Sierra Leone|SG Singapore|SK Slovakia|SI Slovenia|SB Solomon Is.|SO Somalia|ZA South Africa|SS S. Sudan|ES Spain|LK Sri Lanka|SD Sudan|SR Suriname|SZ Swaziland|SE Sweden|CH Switzerland|SY Syria|TJ Tajikistan|TZ Tanzania|TH Thailand|TL Timor-Leste|TG Togo|TO Tonga|TT Trinidad and Tobago|TN Tunisia|TR Turkey|TM Turkmenistan|TC Turks and Caicos Is.|UG Uganda|UA Ukraine|AE United Arab Emirates|GB United Kingdom|US United States|UY Uruguay|UZ Uzbekistan|VU Vanuatu|VE Venezuela|VN Vietnam|VI U.S. Virgin Is.|EH W. Sahara|YE Yemen|ZM Zambia|ZW Zimbabwe|AX Aland`;

const WORLD_NAMES = new Map(NAMES.split('|').map((pair) => [pair.slice(0, 2), pair.slice(3)]));

/** The `world` region name of an ISO 3166-1 alpha-2 code. */
export function worldRegion(iso2: string): string {
  return WORLD_NAMES.get(iso2.toUpperCase()) ?? iso2;
}
