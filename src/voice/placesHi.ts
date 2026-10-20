// Indian places as people say them: Devanagari and common romanized spellings, mapped to the English
// name the geocoder knows. The first Devanagari spelling is the one shown and spoken in Hindi.

/** [English name, ...other spellings]. */
const PLACES: ReadonlyArray<readonly string[]> = [
  // Metros
  ['Delhi', 'दिल्ली', 'देहली', 'dilli', 'dehli'],
  ['New Delhi', 'नई दिल्ली', 'नयी दिल्ली', 'nai dilli'],
  ['Mumbai', 'मुंबई', 'बंबई', 'bombay', 'bambai'],
  ['Bengaluru', 'बेंगलुरु', 'बेंगलूरु', 'बैंगलोर', 'बेंगलोर', 'bangalore', 'banglore', 'bengalooru', 'bengaluru'],
  ['Chennai', 'चेन्नई', 'चेन्नै', 'मद्रास', 'madras'],
  ['Kolkata', 'कोलकाता', 'कलकत्ता', 'calcutta', 'kolkatta'],
  ['Hyderabad', 'हैदराबाद', 'hydrabad'],
  ['Pune', 'पुणे', 'पुने', 'पूना', 'poona', 'puna'],
  ['Ahmedabad', 'अहमदाबाद', 'अमदावाद', 'amdavad', 'ahmadabad'],
  // State and UT capitals
  ['Jaipur', 'जयपुर', 'jaypur'],
  ['Lucknow', 'लखनऊ', 'lakhnau', 'lakhnow'],
  ['Chandigarh', 'चंडीगढ़', 'chandigad'],
  ['Bhopal', 'भोपाल'],
  ['Patna', 'पटना'],
  ['Ranchi', 'रांची'],
  ['Raipur', 'रायपुर'],
  ['Bhubaneswar', 'भुवनेश्वर', 'bhubaneshwar', 'bhuvaneshwar'],
  ['Gandhinagar', 'गांधीनगर', 'gandhi nagar'],
  ['Shimla', 'शिमला', 'simla'],
  ['Dehradun', 'देहरादून', 'dehra dun'],
  ['Thiruvananthapuram', 'तिरुवनंतपुरम', 'त्रिवेंद्रम', 'trivandrum'],
  ['Guwahati', 'गुवाहाटी', 'gauhati'],
  ['Panaji', 'पणजी', 'पंजिम', 'panjim'],
  ['Srinagar', 'श्रीनगर'],
  ['Jammu', 'जम्मू'],
  ['Leh', 'लेह'],
  ['Shillong', 'शिलांग'],
  ['Gangtok', 'गंगटोक'],
  ['Imphal', 'इंफाल'],
  ['Agartala', 'अगरतला'],
  ['Aizawl', 'आइजोल'],
  ['Kohima', 'कोहिमा'],
  ['Itanagar', 'ईटानगर'],
  ['Puducherry', 'पुडुचेरी', 'पांडिचेरी', 'pondicherry', 'pondy'],
  // North
  ['Agra', 'आगरा'],
  ['Mathura', 'मथुरा'],
  ['Vrindavan', 'वृंदावन', 'brindavan', 'vrindaban'],
  ['Noida', 'नोएडा', 'नॉएडा'],
  ['Greater Noida', 'ग्रेटर नोएडा'],
  ['Gurugram', 'गुरुग्राम', 'गुड़गांव', 'gurgaon', 'gurugram'],
  ['Ghaziabad', 'गाजियाबाद'],
  ['Faridabad', 'फरीदाबाद'],
  ['Meerut', 'मेरठ'],
  ['Aligarh', 'अलीगढ़'],
  ['Kanpur', 'कानपुर'],
  ['Varanasi', 'वाराणसी', 'बनारस', 'काशी', 'banaras', 'benares', 'kashi'],
  ['Prayagraj', 'प्रयागराज', 'इलाहाबाद', 'allahabad'],
  ['Ayodhya', 'अयोध्या'],
  ['Gorakhpur', 'गोरखपुर'],
  ['Bareilly', 'बरेली'],
  ['Moradabad', 'मुरादाबाद'],
  ['Jhansi', 'झांसी'],
  ['Etawah', 'इटावा'],
  ['Amritsar', 'अमृतसर'],
  ['Ludhiana', 'लुधियाना'],
  ['Jalandhar', 'जालंधर'],
  ['Patiala', 'पटियाला'],
  ['Pathankot', 'पठानकोट'],
  ['Ambala', 'अंबाला'],
  ['Panipat', 'पानीपत'],
  ['Karnal', 'करनाल'],
  ['Kurukshetra', 'कुरुक्षेत्र'],
  ['Sonipat', 'सोनीपत'],
  ['Rohtak', 'रोहतक'],
  ['Hisar', 'हिसार', 'hissar'],
  ['Katra', 'कटरा'],
  ['Ladakh', 'लद्दाख'],
  // Rajasthan
  ['Udaipur', 'उदयपुर'],
  ['Jodhpur', 'जोधपुर'],
  ['Jaisalmer', 'जैसलमेर'],
  ['Bikaner', 'बीकानेर'],
  ['Ajmer', 'अजमेर'],
  ['Pushkar', 'पुष्कर'],
  ['Kota', 'कोटा'],
  ['Mount Abu', 'माउंट आबू', 'mount aabu'],
  ['Chittorgarh', 'चित्तौड़गढ़', 'chittor'],
  ['Neemrana', 'नीमराना'],
  ['Alwar', 'अलवर'],
  ['Bharatpur', 'भरतपुर'],
  ['Sawai Madhopur', 'सवाई माधोपुर'],
  ['Ranthambore', 'रणथंभौर', 'ranthambhore'],
  // Hills
  ['Haridwar', 'हरिद्वार', 'hardwar'],
  ['Rishikesh', 'ऋषिकेश', 'rishikesh', 'hrishikesh'],
  ['Mussoorie', 'मसूरी', 'mussoori', 'masoori', 'mussourie'],
  ['Nainital', 'नैनीताल', 'naini tal'],
  ['Almora', 'अल्मोड़ा'],
  ['Haldwani', 'हल्द्वानी'],
  ['Lansdowne', 'लैंसडाउन'],
  ['Jim Corbett', 'जिम कॉर्बेट', 'कॉर्बेट', 'corbett'],
  ['Auli', 'औली'],
  ['Kedarnath', 'केदारनाथ'],
  ['Badrinath', 'बद्रीनाथ'],
  ['Manali', 'मनाली'],
  ['Kullu', 'कुल्लू', 'kulu'],
  ['Kasol', 'कसोल'],
  ['Dharamshala', 'धर्मशाला', 'dharamsala'],
  ['McLeod Ganj', 'मैकलोडगंज', 'mcleodganj', 'mcleod ganj'],
  ['Dalhousie', 'डलहौजी'],
  ['Kasauli', 'कसौली'],
  ['Solan', 'सोलन'],
  // West
  ['Goa', 'गोवा'],
  ['Lonavala', 'लोनावला', 'लोनावाला', 'lonavla'],
  ['Khandala', 'खंडाला'],
  ['Mahabaleshwar', 'महाबलेश्वर'],
  ['Matheran', 'माथेरान'],
  ['Alibag', 'अलीबाग', 'alibaug'],
  ['Igatpuri', 'इगतपुरी'],
  ['Nashik', 'नासिक', 'नाशिक', 'nasik'],
  ['Shirdi', 'शिर्डी'],
  ['Thane', 'ठाणे'],
  ['Navi Mumbai', 'नवी मुंबई'],
  ['Ratnagiri', 'रत्नागिरी'],
  ['Satara', 'सतारा'],
  ['Kolhapur', 'कोल्हापुर'],
  ['Solapur', 'सोलापुर', 'sholapur'],
  ['Aurangabad', 'औरंगाबाद', 'sambhajinagar'],
  ['Nagpur', 'नागपुर'],
  ['Amravati', 'अमरावती'],
  ['Surat', 'सूरत'],
  ['Vadodara', 'वडोदरा', 'बड़ौदा', 'baroda'],
  ['Rajkot', 'राजकोट'],
  ['Dwarka', 'द्वारका'],
  ['Somnath', 'सोमनाथ'],
  ['Bhuj', 'भुज'],
  ['Kutch', 'कच्छ', 'kachchh', 'kachh'],
  ['Statue of Unity', 'स्टैच्यू ऑफ यूनिटी'],
  ['Saputara', 'सापुतारा'],
  ['Daman', 'दमन'],
  ['Diu', 'दीव'],
  // Central and east
  ['Indore', 'इंदौर'],
  ['Ujjain', 'उज्जैन'],
  ['Gwalior', 'ग्वालियर'],
  ['Jabalpur', 'जबलपुर'],
  ['Khajuraho', 'खजुराहो'],
  ['Pachmarhi', 'पचमढ़ी'],
  ['Orchha', 'ओरछा'],
  ['Bilaspur', 'बिलासपुर'],
  ['Puri', 'पुरी'],
  ['Cuttack', 'कटक'],
  ['Konark', 'कोणार्क'],
  ['Jamshedpur', 'जमशेदपुर'],
  ['Dhanbad', 'धनबाद'],
  ['Muzaffarpur', 'मुजफ्फरपुर'],
  ['Siliguri', 'सिलीगुड़ी'],
  ['Darjeeling', 'दार्जिलिंग'],
  ['Durgapur', 'दुर्गापुर'],
  ['Asansol', 'आसनसोल'],
  ['Digha', 'दीघा'],
  // South
  ['Mysuru', 'मैसूर', 'मैसूरु', 'mysore'],
  ['Ooty', 'ऊटी', 'ooti', 'udhagamandalam'],
  ['Kodaikanal', 'कोडाइकनाल', 'kodai'],
  ['Coorg', 'कूर्ग', 'कुर्ग', 'kodagu', 'madikeri'],
  ['Chikkamagaluru', 'चिकमगलूर', 'chikmagalur'],
  ['Mangaluru', 'मंगलौर', 'मंगलुरु', 'mangalore'],
  ['Udupi', 'उडुपी'],
  ['Gokarna', 'गोकर्ण'],
  ['Hampi', 'हम्पी'],
  ['Hubballi', 'हुबली', 'hubli'],
  ['Belagavi', 'बेलगाम', 'belgaum'],
  ['Davanagere', 'दावणगेरे', 'davangere'],
  ['Tumakuru', 'तुमकुर', 'tumkur'],
  ['Hosur', 'होसुर'],
  ['Krishnagiri', 'कृष्णागिरी'],
  ['Kochi', 'कोच्चि', 'कोचीन', 'cochin'],
  ['Munnar', 'मुन्नार'],
  ['Alappuzha', 'अलप्पुझा', 'अलेप्पी', 'alleppey'],
  ['Kozhikode', 'कोझिकोड', 'calicut'],
  ['Thrissur', 'त्रिशूर', 'trichur'],
  ['Wayanad', 'वायनाड'],
  ['Varkala', 'वर्कला'],
  ['Kovalam', 'कोवलम'],
  ['Coimbatore', 'कोयंबटूर', 'kovai'],
  ['Madurai', 'मदुरै'],
  ['Tiruchirappalli', 'तिरुचिरापल्ली', 'त्रिची', 'trichy', 'tiruchi'],
  ['Thanjavur', 'तंजावुर', 'tanjore'],
  ['Salem', 'सेलम'],
  ['Vellore', 'वेल्लोर'],
  ['Mahabalipuram', 'महाबलीपुरम', 'mamallapuram'],
  ['Rameswaram', 'रामेश्वरम', 'rameshwaram'],
  ['Kanyakumari', 'कन्याकुमारी'],
  ['Tirupati', 'तिरुपति'],
  ['Vijayawada', 'विजयवाड़ा'],
  ['Visakhapatnam', 'विशाखापत्तनम', 'विजाग', 'vizag', 'vishakhapatnam'],
  ['Warangal', 'वारंगल'],
  ['Kurnool', 'कुरनूल'],
  ['Nellore', 'नेल्लोर'],
];

/**
 * Folds spelling differences that don't change a word: case, Devanagari digits, nukta, chandrabindu,
 * joiners and a nasal consonant before another consonant written as anusvara (पन्द्रह = पंद्रह).
 */
export function fold(s: string): string {
  return s
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\u0966-\u096f]/g, (d) => String(d.charCodeAt(0) - 0x966))
    .normalize('NFD')
    .replace(/\u093c/g, '')
    .normalize('NFC')
    .replace(/\u0901/g, '\u0902')
    .replace(/[\u0919\u091e\u0923\u0928\u092e]\u094d(?=[\u0915-\u0939])/g, '\u0902')
    .replace(/[\u200c\u200d]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const DEVANAGARI = /[\u0900-\u097f]/;
const byKey = new Map<string, string>();
const hindiName = new Map<string, string>();
for (const [name, ...variants] of PLACES) {
  for (const v of [name, ...variants]) byKey.set(fold(v), name);
  const hi = variants.find((v) => DEVANAGARI.test(v));
  if (hi) hindiName.set(name, hi);
}

/** Longest place name, in words; callers try phrases up to this length. */
export const MAX_PLACE_WORDS = Math.max(...[...byKey.keys()].map((k) => k.split(' ').length));

export const PLACE_COUNT = PLACES.length;

/** The English name for a place as said, or null when it isn't in the list. */
export function lookupPlace(said: string): string | null {
  return byKey.get(fold(said)) ?? null;
}

/** The Hindi spelling of a place for display and speech; unknown names come back unchanged. */
export function placeInHindi(name: string): string {
  return hindiName.get(name) ?? hindiName.get(lookupPlace(name) ?? '') ?? name;
}
