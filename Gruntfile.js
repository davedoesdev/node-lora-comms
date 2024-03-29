"use strict";

const args = process.argv.filter(a => a.startsWith('--')).map(a => ` ${a}`);
// note we can't use npx mocha because npx initialises the thread pool
// before we can set UV_THREADPOOL_SIZE in lib/lora-comms.js
const test_cmd = `./node_modules/.bin/mocha --timeout 30000 --bail ${args}`;
const c8 = "npx c8 -x Gruntfile.js -x 'test/**'";
const build_args = process.argv.indexOf('--simulate') >= 0 ? '--simulate=true' : '';

module.exports = function (grunt)
{
    grunt.initConfig(
    {
        exec: {
            rebuild: {
                cmd: `npx node-gyp rebuild --debug ${build_args}`
            },

            test: {
                cmd: test_cmd,
                stdio: 'inherit'
            },

            cover_build: {
                cmd: `npx node-gyp rebuild --debug --coverage=true ${build_args}`
            },

            cover_init: {
                cmd: 'mkdir -p coverage && rm -f coverage/lcov_addon_base.info && lcov --rc lcov_branch_coverage=0 --zerocounters --directory build && lcov --rc lcov_branch_coverage=0 --capture --initial --directory build --output-file coverage/lcov_addon_base.info'
            },

            cover: {
                cmd: `${c8} ${test_cmd}`
            },

            cover_lcov: {
                cmd: `rm -f coverage/lcov.info && ${c8} report -r lcovonly && rm -f coverage/lcov_addon.info && lcov --rc lcov_branch_coverage=0 --capture --directory build --output-file coverage/lcov_addon.info && rm -f coverage/lcov_combined.info && lcov --rc lcov_branch_coverage=1 --add-tracefile coverage/lcov.info --add-tracefile coverage/lcov_addon_base.info --add-tracefile coverage/lcov_addon.info --output-file coverage/lcov_combined.info && rm -f coverage/lcov_final.info && lcov --rc lcov_branch_coverage=1 --remove coverage/lcov_combined.info '/usr/*' $PWD'/node_modules/*' $PWD/test/simulate.cc --output-file coverage/lcov_final.info`
            },

            cover_report: {
                cmd: 'genhtml --rc lcov_branch_coverage=1 --demangle-cpp -o coverage/lcov-report coverage/lcov_final.info'
            },

            cover_check: {
                // lines% functions% branches%
                cmd: "if [ \"$(lcov --rc lcov_branch_coverage=1 --list coverage/lcov_final.info | grep Total | grep -o '[0-9.]\\+%' | tr '\\n' ' ')\" != '100% 100% 100% ' ]; then exit 1; fi"
            },

            documentation: {
                cmd: [
                    'npx documentation build -c documentation.yml -f html -o docs lib/lora-comms.js',
                    'asciidoc -b docbook -o - README.adoc | pandoc -f docbook -t gfm -o README.md'
                ].join('&&')
            }
        },

        eslint: {
            target: [
                'Gruntfile.js',
                'lib/**/*.js',
                'test/**/*.js',
                'example.js'
            ]
        }
    });

    grunt.loadNpmTasks('grunt-exec');
    grunt.loadNpmTasks('grunt-eslint');

    grunt.registerTask('build', 'exec:build');
    grunt.registerTask('rebuild', 'exec:rebuild');
    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', 'exec:test');
    grunt.registerTask('coverage', ['exec:cover_build',
                                    'exec:cover_init',
                                    'exec:cover',
                                    'exec:cover_lcov',
                                    'exec:cover_report',
                                    'exec:cover_check']);
    grunt.registerTask('docs', 'exec:documentation');
    grunt.registerTask('default', ['lint', 'test']);
};
