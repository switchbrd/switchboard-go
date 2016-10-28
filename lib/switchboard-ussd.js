// Possible configuration items:
//
// * translation.<lang>:
//     Jed translation JSON for language (e.g. sw). Optional. If ommitted,
//     untranslated strings are used.
//
// * config:
//     * qa:
//         Set to true to turn on QA features. Default is false.
//     * default_lang:
//         Default language. Default is 'en'.
//     * swb_api:
//         Dictionary of username, password and url of the Switchboard API.
//         If ommitted, the dummy API is used instead.
//     * sms_tag:
//         Two element list of [pool, tag] giving the Go endpoint to send SMSes
//         out via. If ommitted, SMSes are not sent.
//     * metric_store:
//         Name of the metric store to use. If omitted, metrics are sent
//         to the metric store named 'default'.
//     * valid_user_addresses:
//         JSON list of allowed from_addr regular expression patterns.
//         Optional. If omitted, all from_addr values are allowed.
//
// It is suspected that the Vodacom Tz prefixes are: 255743 - 6, 25575 and
// 25576.
//
// Metrics produced:
//
// * ussd_sessions
// * unique_users
// * first_session_completed
// * second_session_completed
// * sessions_taken_to_register (average)
// * session_new_in.<state-name>
// * session_closed_in.<state-name>
// * possible_timeout_in.<state-name>
// * state_entered.<state-name>
// * state_exited.<state-name>

var vumigo = require("vumigo_v01");
var jed = require("jed");

if (typeof api === "undefined") {
    // testing hook (supplies api when it is not passed in by the real sandbox)
    var api = this.api = new vumigo.dummy_api.DummyApi();
}

var Promise = vumigo.promise.Promise;
var success = vumigo.promise.success;
var maybe_promise = vumigo.promise.maybe_promise;
var State = vumigo.states.State;
var Choice = vumigo.states.Choice;
var ChoiceState = vumigo.states.ChoiceState;
var LanguageChoice = vumigo.states.LanguageChoice;
var PaginatedChoiceState = vumigo.states.PaginatedChoiceState;
var FreeText = vumigo.states.FreeText;
var EndState = vumigo.states.EndState;
var InteractionMachine = vumigo.state_machine.InteractionMachine;
var StateCreator = vumigo.state_machine.StateCreator;


function DummySwitchboardApi(im) {
    
    var self = this;
    
    self.im = im;
    
    self.list_cadres = function() {
        var p = new Promise();
        p.callback([
            // Medical Specialist, AMO and Dental Specialist
            // use numerical IDs to match default IDs for cadres
            // with specialties.
            {id: 1, text: "Medical Specialist"},
            {id: "mo", text: "MO"}, // Medical Officer
            {id: 60, text: "AMO"}, // Assistant Medical Officer
            {id: "co", text: "CO"}, // Clinical Officer
            {id: "aco", text: "ACO"}, // Assistant Clinical Officer
            {id: 67, text: "Dental Specialist"},
            {id: "do", text: "Dental Officer"},
            {id: "ado", text: "ADO"}, // Assitant Dental Officer
            {id: "dt", text: "Dental Therapist"}
        ]);
        return p;
    };
    
    self.list_districts = function(query) {
        var p = new Promise();
        p.callback([
            {id: "kigoma-mc", text: "Kigoma MC"},
            {id: "kigoma-dc", text: "Kigoma DC"},
            {id: "kasulu-dc", text: "Kasulu DC"}
        ]);
        return p;
    };
    
    self.list_facility_types = function() {
        var p = new Promise();
        var _ = self.im.i18n;
        p.callback([
            {id: "hospital", text: _.gettext("Hospital")},
            {id: "health-centre", text: _.gettext("Health Centre")},
            {id: "dispensary", text: _.gettext("Dispensary")},
            {id: "clinic", text: _.gettext("Clinic")},
            {id: "mhsw", text: _.gettext("Ministry of Health and " +
                                         "Social Welfare")},
            {id: "council", text: _.gettext("Council")},
            {id: "training", text: _.gettext("Training Institution")},
            {id: "zonal-training", text: _.gettext("Zonal Training" +
                                                   " Centre")},
            {id: "ngo", text: _.gettext("NGO")}
        ]);
        return p;
    };
    
    self.list_facilities = function(district, facility_type, query) {
        var p = new Promise();
        p.callback([
            {id: "wazazi-galapo", text: "Wazazi Galapo"},
            {id: "wazazi-magugu", text: "Wazazi Magugu"},
            {id: "wazazu-mchuo", text: "Wazazu Mchuo"}
        ]);
        return p;
    };
    
    self.list_specialities = function(cadre_id) {
        var p = new Promise();
        var specialities = [];
        if (cadre_id == 67) {
            specialities = [
                {id: "cd", text: "Community Dentistry"},
                {id: "ms", text: "Maxilofacial Surgery"}
            ];
        }
        else if (cadre_id == 1) {
            specialities = [
                {id: "anaesthesia", text: "Anaesthesia"},
                {id: "anatomy", text: "Anatomy"}
            ];
        }
        else if (cadre_id == 60) {
            specialities = [
                {id: "anaesthesiology", text: "Anaesthesiology"},
                {id: "em", text: "Emergency Medicime"}
            ];
        }
        p.callback(specialities);
        return p;
    };
    
    self.submit_unknown_cadre = function(user_addr, cadre_name) {
        // Do nothing.
        return success();
    };
    
    self.submit_unknown_facility = function(user_addr, facility, region,
                                            facility_type) {
        // Do nothing.
        return success();
    };
    
    self.cadre_needs_specialties = function(cadre_id) {
        var cadres_with_specialties = [1, 67, 60];
        var needs_specialties = cadres_with_specialties.some(
            function (i) {
                return i == cadre_id;
            });
        return success(needs_specialties);
    };
    
    self.register_health_worker = function(health_worker) {
        return success();
    };
}


function SwitchboardApiError(msg) {
    var self = this;
    self.msg = msg;
    
    self.toString = function() {
        return "<SwitchboardApiError: " + self.msg + ">";
    };
}


function SwitchboardApi(im, url, username, password) {
    
    var self = this;
    
    self.im = im;
    self.lang = im.user.lang || im.config.default_lang || "en";
    self.url = url;
    self.headers = {
        'Content-Type': ['application/json']
    };
    
    if (username) {
        var hash = (new Buffer(username + ":" + password)).toString('base64');
        self.headers['Authorization'] = ['Basic ' + hash];
    }
    
    self.check_reply = function(reply, url, method, data, ignore_error) {
        var error;
        if (reply.success && reply.code == 200) {
            var json = JSON.parse(reply.body);
            if (json.status === 0) {
                return json;
            }
            error = ("API did not return status OK (got " +
                     json.status + " instead)");
        }
        else {
            error = reply.reason;
        }
        var error_msg = ("SwB API " + method + " to " + url + " failed: " +
                         error);
        if (typeof data != 'undefined') {
            error_msg = error_msg + '; data: ' + JSON.stringify(data);
        }
        self.im.log(error_msg);
        if (!ignore_error) {
            throw new SwitchboardApiError(error_msg);
        }
    };
    
    self.api_get = function(api_cmd, params) {
        var p = new Promise();
        var url = self.url + api_cmd;
        var items = [];
        for (var key in params) {
            items[items.length] = (encodeURIComponent(key) + '=' +
                                   encodeURIComponent(params[key]));
        }
        if (items.length !== 0) {
            url = url + '?' + items.join('&');
        }
        self.im.api.request("http.get", {
            url: url,
            headers: self.headers
        },
			    function(reply) {
				var json = self.check_reply(reply, url, 'GET', false);
				p.callback(json);
			    });
        return p;
    };
    
    self.api_post = function(api_cmd, data, ignore_error) {
        var p = new Promise();
        var url = self.url + api_cmd;
        self.im.api.request("http.post", {
            url: url,
            headers: self.headers,
            data: JSON.stringify(data)
        },
			    function(reply) {
				var json = self.check_reply(reply, url, 'POST', data,
							    ignore_error);
				p.callback(json);
			    });
        return p;
    };
    
    // only allow printable ASCII x20 (space) to x73 (tilde)
    self.non_printable_ascii_re = /[^\x20-\x7E]/g;
    
    self.clean_title = function(title) {
        return title.replace(self.non_printable_ascii_re, '?');
    };
    
    self.list_cadres = function() {
        var p = self.api_get('specialties', {lang: self.lang});
        p.add_callback(function (result) {
            var cadres = result.specialties.filter(function (s) {
                return (s.parent_specialty_id === null);
            });
            return cadres.map(function (s) {
                var text = s.short_title ? s.short_title : s.title;
                text = self.clean_title(text);
                return {id: s.id, text: text};
            });
        });
        return p;
    };
    
    self.list_districts = function(query) {
        var p = self.api_get('regions', {
            type: 'District',
            title: query,
            lang: self.lang
        });
        p.add_callback(function (result) {
            return result.regions.map(function (r) {
                return {id: r.id, text: self.clean_title(r.title)};
            });
        });
        return p;
    };
    
    self.list_facility_types = function() {
        var p = self.api_get('facility-types', {lang: self.lang});
        p.add_callback(function (result) {
            return result.facility_types.map(function (f) {
                return {id: f.id, text: self.clean_title(f.title)};
            });
        });
        return p;
    };
    
    self.deduplicate_items = function(items, get_title, dedup) {
        var title_map = {};
        var title = null;
        var title_items;
        items.forEach(function (item) {
            title = get_title(item);
            if (!title_map[title]) {
                title_map[title] = [item];
                return;
            }
            title_items = title_map[title];
            if (title_items.length == 1) {
                dedup(title_items[0]);
            }
            dedup(item);
            title_items.push(item);
        });
    };
    
    self.list_facilities = function(district, facility_type, query) {
        var params = {
            title: query,
            lang: self.lang
        };
        if (district !== null) {
            params.region = district;
        }
        if (facility_type !== null) {
            params.type = facility_type;
        }
        var p = self.api_get('facilities', params);
        p.add_callback(function (result) {
            self.deduplicate_items(
                result.facilities,
                function(f) { return f.title },
                function(f) {
                    if (f.region && f.region.title)
                        f.title = f.title + " " + f.region.title;
                }
            );
            return result.facilities.map(function (f) {
                return {id: f.id, text: self.clean_title(f.title)};
            });
        });
        return p;
    };
    
    self.list_specialities = function(cadre_id) {
        cadre_id = Number(cadre_id);
        var p = self.api_get('specialties', {lang: self.lang});
        p.add_callback(function (result) {
            var specialties = result.specialties.filter(function (s) {
                return (s.parent_specialty_id === cadre_id);
            });
            return specialties.map(function (s) {
                var text = s.short_title ? s.short_title : s.title;
                text = self.clean_title(text);
                return {id: s.id, text: text};
            });
        });
        return p;
    };
    
    self.submit_unknown_cadre = function(user_addr, cadre_name) {
        var p = self.api_post('specialties', {
            msisdn: user_addr.slice(0, 32), // maximum size allowed by API
            title: cadre_name,
            parent_specialty: null,
            lang: self.lang
        }, true); // TODO: stop ignoring errors once API accepts duplicates
        p.add_callback(function (result) {
            return (typeof result == "undefined") ? null : result.id;
        });
        return p;
    };
    
    self.submit_unknown_facility = function(user_addr, facility, region,
                                            facility_type) {
        var p = self.api_post('facilities', {
            msisdn: user_addr.slice(0, 32), // maximum size allowed by API
            title: facility,
            region: region,
            type: facility_type,
            address: null,
            lang: self.lang
        }, true); // TODO: stop ignoring errors once API accepts duplicates
        p.add_callback(function (result) {
            return (typeof result == "undefined") ? null : result.id;
        });
        return p;
    };
    
    self.submit_search_number = function(phone_number) {
	var p = self.api_post('in_cug', {
	    search_number: phone_number, //the number is saved in the field: search_number
	    lang: self.lang
	}, true); 
	return p;
    };  

    self.update_healthworker_profile = function(user_addr, element, value){
	var p = self.api_post('update_profile', {
	    data_field: element,
	    new_value: value,
	    msisdn: user_addr.slice(0, 32),
	    lang: self.lang
	}, true);
	return p;
    };
    
    self.cadre_needs_specialties = function(cadre_id) {
        cadre_id = Number(cadre_id);
        var p = self.api_get('specialties', {lang: self.lang});
        p.add_callback(function (result) {
            var cadres = result.specialties.filter(function (s) {
                return (s.id === cadre_id);
            });
            if (cadres.length != 1) {
                return false;
            }
            var cadre = cadres[0];
            return cadre.is_query_subspecialties;
        });
        return p;
    };
    
    self.register_health_worker = function(health_worker) {
        var p = self.api_post('health-workers', {
            name: health_worker.full_name, // string (required)
            surname: health_worker.surname, // string (required)
	    firstname: health_worker.firstname, // string (required)
            specialties: health_worker.specialties, // [SpecialtyID, ...]
            country: health_worker.country, // string
            facility: health_worker.facility, // FacilityID, primary facility
            vodacom_phone: health_worker.vodacom_phone, // string, MSISDN
            mct_registration_number: health_worker.registration_number, // str
            mct_payroll_number: health_worker.cheque_number, // string
            language: self.lang
        });
        return p;
    };
}


function RegisterHealthWorker() {
    var self = this;
    StateCreator.call(self, "intro");
    
    var _ = new jed({});
    self.options_per_page = 5;
    self.characters_per_page = 163;
    
    // SwB API creator
    
    self.swb_api = function(im) {
        var cfg = im.config.swb_api;
        if (!cfg) {
            im.log("Using dummy Switchboard API.");
            return new DummySwitchboardApi(im);
        }
        im.log("Using real Switchboard API.");
        return new SwitchboardApi(im, cfg.url, cfg.username, cfg.password);
    };
    
    self.qa = function(im) {
        if (im.config.qa) {
            return true;
        }
        return false;
    };
    
    // Session metrics helper
    
    self.incr_metric = function(im, metric) {
        var p = new Promise();
        p.add_callback(function (value) {
            im.metrics.fire_max(metric, value);
        });
        im.api.request(
            "kv.incr", {key: "metrics." + metric, amount: 1},
            function(reply) {
                if (reply.success) {
                    p.callback(reply.value);
                }
                else {
                    im.log("Failed to increment metric " + metric + ": " +
                           reply.reason);
                    p.callback(0);
                }
            });
        return p;
    }
    
    // SMSes
    
    self.send_sms = function(im, content) {
        var sms_tag = im.config.sms_tag;
        if (!sms_tag) return success(true);
	
        var p = new Promise();
        p.add_callback(function(success) {
            im.log('SMS sent: ' + success);
        });
	
        im.api.request("outbound.send_to_tag", {
            to_addr: im.user_addr,
            content: content,
            tagpool: sms_tag[0],
            tag: sms_tag[1]
        }, function(reply) {
            p.callback(reply.success);
        });
        return p;
    };
    
    self.send_sms_session1_abort = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("If you would like to register at a later" +
                            " date please dial *149*24#.");
        return self.send_sms(im, msg);
    };
    
    self.send_sms_session1_end = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("Thank you for beginning your registration" +
                            " process. Please dial *149*24# again to" +
                            " complete your registration in a few easy steps.");
        return self.send_sms(im, msg);
    };
    
    self.send_sms_session2_end = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("Thank you for registering with The Health" +
                            " Network Programme. We will verify your" +
                            " registration within 2 weeks and confirm by SMS" +
                            " when you can make free calls.")
        return self.send_sms(im, msg);
    };
    
    self.send_sms_first_possible_timeout = function(im) {
        var _ = im.i18n;
        var msg = _.gettext("Your session has ended but you have not" +
                            " completed your registration. Please dial" +
                            " *149*24# again to continue with your" +
                            " registration where you left off.");
        return self.send_sms(im, msg);
    };
    
    // Vodacom number checker
    
    self.check_from_addr = function(im) {
        var patterns = im.config.valid_user_addresses;
        if (!patterns ||
            typeof patterns.length == 'undefined' ||
            patterns.length === 0) {
            return true;
        }
        var okay = patterns.some(function (p) {
            return Boolean(im.user_addr.match(p));
        });
        return okay;
    };
    
    // Session handling

    self.get_user_item = function(user, item, default_value) {
        var custom = user.custom || {};
        var value = custom[item];
        return (typeof value != 'undefined') ? value : default_value;
    };
    
    self.set_user_item = function(user, item, value) {
        if (typeof user.custom == 'undefined') {
            user.custom = {};
        }
        user.custom[item] = value;
    };
    
    self.inc_user_item = function(user, item) {
        var value = self.get_user_item(user, item, 0) + 1;
        self.set_user_item(user, item, value);
        return value;
    };
    
    // IM event callbacks
    
    self.on_session_new = function(event) {
        var p = self.incr_metric(event.im, 'ussd_sessions');
        p.add_callback(function () {
            return event.im.metrics.fire_inc('session_new_in.' +
                                             event.im.current_state.name);
        });
        p.add_callback(function () {
            return self.inc_user_item(event.im.user, 'ussd_sessions');
        });
        return p;
    };
    
    self.on_session_close = function(event) {
        var p = event.im.metrics.fire_inc('session_closed_in.' +
                                          event.im.current_state.name);
        if (event.data.possible_timeout) {
            p.add_callback(function () {
                return event.im.metrics.fire_inc('possible_timeout_in.' +
                                                 event.im.current_state.name);
            });
            var timeouts = self.inc_user_item(event.im.user,
                                              'possible_timeouts');
            if (timeouts <= 1) {
                p.add_callback(function () {
                    self.send_sms_first_possible_timeout(event.im);
                });
            }
        }
        return p;
    };
    
    self.on_new_user = function(event) {
        return self.incr_metric(event.im, 'unique_users');
    };
    
    self.on_state_enter = function(event) {
        return event.im.metrics.fire_inc('state_entered.' + event.data.state.name);
    };
    
    self.on_state_exit = function(event) {
        return event.im.metrics.fire_inc('state_exited.' + event.data.state.name);
    };
    
    // Create a healthworker based on user's answers
    self.create_health_worker = function (im) {
        var ans = im.get_user_answer;
        var swb_api = self.swb_api(im);
        var hw = {};
	
        hw.vodacom_phone = im.user_addr;
        hw.country = "TZ";
        hw.full_name = ans("fname") + " " + ans("sname");
		hw.firstname = ans("fname");
        hw.surname = ans("sname");
        // hw.specialties = [ans("cadre")];
        hw.specialties = [];
	 
        var registration_number = ans("rnumber");
        if (registration_number && !registration_number.match('^[0Oo]$'))
            hw.registration_number = registration_number;
	
        var facility = ans("facility_select");
        if (facility)
            hw.facility = facility;
	
        var specialty = ans("select_speciality");
        if (specialty)
            hw.specialties[hw.specialties.length] = specialty;
	
        return hw;
    };
    

    // Session 1

    self.add_state(new ChoiceState(
        "intro",
	function (choice) {
            if (choice.value == "1"){
		return "fname";
	    }
	    else if(choice.value == "2"){
		return "endhere_cancel";
	    }
	},
        _.gettext("Welcome to HNP?\n To register select 1!\n"+
		  "  Kujiandikisha chagua 1"),
        [
            new Choice("1", _.gettext("I want register!\n"+
				      "  Nataka Kujiandikisha")),
            new Choice("2", _.gettext("Cancel!\n"))
        ]
    ));
    
    // register
    self.add_state(new FreeText(
        "fname",
        "sname",
        _.gettext("Please enter your first name.\n\nIngiza Jina lako la Kwanza")
    ));
    
    self.add_state(new FreeText(
        "sname",
        "oname",
        _.gettext("Please enter your surname.\n\nIngiza jina la Ukoo")
    ));
    
    
    self.add_state(new FreeText(
        "oname",
        "rnumber",
        _.gettext("Enter your other name\n\nIngiza majina mengine kama yapo")
    ));
    
    self.add_state(new FreeText(
        "rnumber",
        "terms_and_conditions",
        _.gettext("Enter your professional council reg #.\nIngiza namba ya usajili kwenye baraza")        
    ));
    
    
    self.add_state(new ChoiceState(
        "terms_and_conditions",
        function (choice) {
            return (choice.value == "yes" ?
                    "session1_end" :
                    "session1_abort_yn");
        },
        _.gettext("Do you agree to the terms and conditions as laid" +
                  " out at http://www.healthnetwork.or.tz ?" +
                  " Your local DMO will also have a copy."),
        [
            new Choice("yes", _.gettext("Yes")),
            new Choice("no", _.gettext("No"))
        ]
    ));
    self.add_state(new ChoiceState(
        "session1_abort_yn",
        function (choice) {
            return (choice.value == "yes" ?
                    "session1_abort" :
                    "terms_and_conditions");
        },
        _.gettext("We are sorry but you cannot be registered unless" +
                  " you agree to the terms and conditions. Are you" +
                  " sure you would like to end the registration process?"),
        [
            new Choice("yes", _.gettext("Yes")),
            new Choice("no", _.gettext("No"))
        ]
    ));
    self.add_state(new EndState(
        "session1_abort",
        _.gettext("If you would like to register at a later date" +
                  " please dial *149*24#."),
        "intro",
        {
            on_enter: function () {
                return self.send_sms_session1_abort(this.im);
            }
        }
    ));
    self.add_state(new EndState(
        "session1_end",
        _.gettext("Thank you. You have almost completed your " +
                  "registration process. Please dial *149*24# " +
                  "again to complete just a few more questions."),
        "update_profile",
        {
            on_enter: function () {
                var im = this.im;
                var swb_api = self.swb_api(im);
                var health_worker = self.create_health_worker(im);
                var p = swb_api.register_health_worker(health_worker);
                p.add_callback(function () {
                    return self.incr_metric(im, 'first_session_completed');
                });
                p.add_callback(function () {
                    return self.send_sms_session1_end(im);
                });
                p.add_callback(function () {
                    self.set_user_item(im.user, "registered", 1);
                    var sessions = self.get_user_item(im.user, 'ussd_sessions', 0);
                    return im.metrics.fire_avg('sessions_taken_to_register', sessions);
                });
                return p;
            }
        }
     ));
        
    self.add_state(new EndState(
        "cancel",
        _.gettext("You can register later by dialling *149*24#!\n\nWaweza kujiandikisha baadaye kwa kupiga *149*24#")
    ));
    
    // For a registered person, they should be able to update either names and/ registration number.
    self.add_state(new ChoiceState(
        "update_profile",
        function (choice) {
            if (choice.value == "1"){
		return "enter_number_to_check";
	    }
	    else if(choice.value == "2"){
		return "update_profile_menu";
	    }
	},
        _.gettext("What do you want to do?!\n\n"+
				  "Unataka kufanya nini?"),
        [
            new Choice("1", _.gettext("Check if number is in CUG!\n"+
									  "  Nataka kutafuta kama namba ipo kwenye CUG")),
            new Choice("2", _.gettext("Update My Profile!\n"+
									  "  Nataka kuboresha taarifa zangu"))
        ]
    ));               
    
    //update details
    self.add_state(new ChoiceState(
	"update_profile_menu",
	function (choice){
	    if(choice.value == "1"){
		return "update_firstname";
	    }
	    else if(choice.value == "2"){
		return "update_surname";
	    }
	    else if(choice.value == "3"){
		return "update_registration_number";
	    }
	    else{
		return "invalid_action_selection";
	    }
	},
	_.gettext("Select what you want to update!\n"+
			  "  Chagua taarifa unayotaka kuboresha!"),
	[
	    new Choice("1", _.gettext("First name\n"+
								  "  Jina la Kwanza")),
            new Choice("2", _.gettext("Surname\n"+
									  "  Jina la ukoo (Ubini)")),
            new Choice("3", _.gettext("Registration Number\n"+
									  "  Namba ya usajili."))
	]	
    ));
    
    //Check if a number is in the CUG		
    self.add_state(new FreeText(
	"update_firstname",	
	function (content, done) { 
	    var im = this.im;
	    var swb_api = self.swb_api(im);
	    var firstname = content;
	    var p = swb_api.update_healthworker_profile(im.user_addr, 'firstname', firstname);
	    p.add_callback(function (result) {
                if (typeof result == "undefined"){
                    done("invalid_request");
                }
                else {
		    done("thank_you_update");
		}
	    });
	    return p;
	},
	_.gettext("Please enter your correct firstname!\n\n"+
			  "  Tafadhali, andika jina lako la kwanza kiusahihi!")	
    ));

    self.add_state(new FreeText(
	"update_surname",
	function (content, done) { 
	    var im = this.im;
	    var swb_api = self.swb_api(im);
	    var entered_surname = content;
	    var p = swb_api.update_healthworker_profile(im.user_addr, 'surname', entered_surname);
	    p.add_callback(function (result) {
                if (typeof result == "undefined"){
                    done("invalid_request");
                }
                else {
		    done("thank_you_update");
		}
	    });
	    return p;
	},
	_.gettext("Please enter your correct surname!\n\n"+
			  "  Tafadhali, andika jina lako sahihi la ukoo.")
    ));

    self.add_state(new FreeText(
	"update_registration_number",
	function (content, done) { 
	    var im = this.im;
	    var swb_api = self.swb_api(im);
	    var registration_num  = content;
	    var p = swb_api.update_healthworker_profile(im.user_addr, 'mct_registration_num', registration_num);
	    p.add_callback(function (result) {
                if (typeof result == "undefined"){
                    done("invalid_request");
                }
                else {
		    done("thank_you_update");
		}
	    });
	    return p;
	},
	_.gettext("Please enter your registration/license number!\nThis is "+
			  "the number you get from your professional body like MCT, TNMC, etc!")
    ));

    
    self.add_state(new EndState(
	"thank_you_update",          	
	_.gettext("Thank you for updating your profile!\n\n"+
			  "Tunakushukuru kwa kuboresha taarifa zako"),
        "update_profile"
    ));
    
    self.add_state(new EndState(
	"invalid_action_selection",          	
	_.gettext("The choice was not correct! Repeat dialing *149*24#\n\n"+
			  "Chaguo lako sio sahihi! Rudia tena kwa kupiga *149*24#"),
        "update_profile"
    ));               
    
    self.add_state(new EndState(
        "state_holder",
        _.gettext("We are holding this state until the issue is fixed!"),
        "update_profile"
    ));
    
    //Check if a number is in the CUG		
    self.add_state(new FreeText(
	"enter_number_to_check",
	function (content, done) { 
	    var im = this.im;
	    var swb_api = self.swb_api(im);
	    var phone_number = content;
	    var p = swb_api.submit_search_number(phone_number);
	    p.add_callback(function (result) {
                if (typeof result == "undefined"){
                    done("invalid_request");
                }
                else {
		    if (result.in_cug == "1"){
			done("cug_number_reply_found");
		    }
		    else{
			done("cug_number_reply_not_found");
		    }
                }
	    });
	    return p;
	},
	_.gettext("Please enter the number you want to search in the CUG in the format 07XXXXXXXX\n\n"+
			  "Tafadhali, andika hapa namba unayotaka kujua kama ipo kwenye CUG katika mfumo huu 07XXXXXXXX")    
    ));
    
    self.add_state(new EndState(
	"cug_number_reply_found",
	_.gettext("Thank you! This number is in the CUG! You can call it for free if you are also in the CUG\n\n"+
			  "Namba hii ipo katika CUG, unaweza ukaipigia bure kama nawe upo kwenye CUG."),
        "update_profile"
    ));
    
    self.add_state(new EndState(
	"invalid_request",
	_.gettext("The system failed to query at this time. Try again later\n\n"+
			  "Kuna tatizo la kiufundi kwa sasa. Tafadhali jaribu tena baadaye."),
        "update_profile"
    ));
    
    self.add_state(new EndState(
	"cug_number_reply_not_found",
	_.gettext("Thank you! This number number is not in the CUG! Tell them to register at *149*24#\n\n"+
			  "Asante! Namba hii haipo katika CUG, Mtaarifu mwenye namba ajiandikishe kwa kupiga *149*24#."),
        "update_profile"
    ));  
    
}


// launch app
var states = new RegisterHealthWorker();
var im = new InteractionMachine(api, states);
im.attach();