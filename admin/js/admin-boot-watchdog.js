/* Keep the admin access gate from becoming an endless spinner if a script or
   session request stalls. The gate stays closed; this only offers a retry. */
(function () {
    'use strict';

    var timer = setTimeout(function () {
        if (!document.body || document.body.getAttribute('data-boot') !== 'pending') return;

        var message = document.getElementById('boot-text');
        if (message && !/^(Verifying administrator access|Loading dashboard)/.test(message.textContent)) return;
        var spinner = document.querySelector('#boot-veil .spinner');
        var retry = document.getElementById('boot-retry');
        if (message) message.textContent = 'Administrator access could not be verified. Check your connection and try again.';
        if (spinner) spinner.hidden = true;
        if (retry) retry.hidden = false;
    }, 15000);

    document.addEventListener('DOMContentLoaded', function () {
        var retry = document.getElementById('boot-retry');
        if (retry) retry.addEventListener('click', function () { window.location.reload(); });
        if (document.body && document.body.getAttribute('data-boot') !== 'pending') clearTimeout(timer);
    });
})();
