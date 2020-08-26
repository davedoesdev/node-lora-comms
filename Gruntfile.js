"use strict";

module.exports = function (grunt)
{
    grunt.initConfig(
    {
        exec: {
            build: {
                cmd: 'node-gyp build --debug'
            },

            rebuild: {
                cmd: 'node-gyp rebuild --debug'
            },

            cover_build: {
                cmd: 'node-gyp rebuild --debug --coverage=true'
            },

            cover_init: {
                cmd: 'mkdir -p coverage && rm -f coverage/lcov_addon_base.info && lcov --rc lcov_branch_coverage=0 --zerocounters --directory build && lcov --rc lcov_branch_coverage=0 --capture --initial --directory build --output-file coverage/lcov_addon_base.info'
            },

            cover: {
                cmd: "./node_modules/.bin/nyc -x Gruntfile.js -x 'test/**' ./node_modules/.bin/grunt test"
            },

            cover_lcov: {
                cmd: "rm -f coverage/lcov.info && ./node_modules/.bin/nyc report -r lcovonly && rm -f coverage/lcov_addon.info && lcov --rc lcov_branch_coverage=0 --capture --directory build --output-file coverage/lcov_addon.info && rm -f coverage/lcov_combined.info && lcov --rc lcov_branch_coverage=1 --add-tracefile coverage/lcov.info --add-tracefile coverage/lcov_addon_base.info --add-tracefile coverage/lcov_addon.info --output-file coverage/lcov_combined.info && rm -f coverage/lcov_final.info && lcov --rc lcov_branch_coverage=1 --remove coverage/lcov_combined.info '/usr/*' $PWD'/node_modules/*' --output-file coverage/lcov_final.info"
            },

            cover_report: {
                cmd: 'genhtml --rc lcov_branch_coverage=1 --demangle-cpp -o coverage/lcov-report coverage/lcov2.info'
            },

            cover_check: {
                // lines% functions% branches%
                cmd: "if [ \"$(lcov --rc lcov_branch_coverage=1 --list coverage/lcov_final.info | grep Total | grep -o '[0-9.]\\+%' | tr '\\n' ' ')\" != '100% 100% 100% ' ]; then exit 1; fi"
            },

            coveralls: {
                cmd: 'cat coverage/lcov_final.info | ./node_modules/.bin/coveralls'
            },

            documentation: {
                cmd: './node_modules/.bin/documentation build -c documentation.yml -f html -o docs lib/lora-comms.js'
            },

            serve_documentation: {
                cmd: './node_modules/.bin/documentation serve -w -c documentation.yml lib/lora-comms.js'
            }
        },

        eslint: {
            target: [
                'Gruntfile.js',
                'lib/**/*.js',
                'test/**/*.js',
                'example.js'
            ]
        },

        mochaTest: {
            src: 'test/test.js',
            options: {
                timeout: 30 * 1000
            }
        }
    });

    grunt.loadNpmTasks('grunt-exec');
    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-mocha-test');

    grunt.registerTask('build', 'exec:build');
    grunt.registerTask('rebuild', 'exec:rebuild');
    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', 'mochaTest');
    grunt.registerTask('coverage', ['exec:cover_build',
                                    'exec:cover_init',
                                    'exec:cover',
                                    'exec:cover_lcov',
                                    'exec:cover_report',
                                    'exec:cover_check']);
    grunt.registerTask('coveralls', 'exec:coveralls');
    grunt.registerTask('docs', 'exec:documentation');
    grunt.registerTask('serve_docs', 'exec:serve_documentation');
    grunt.registerTask('default', ['lint', 'test']);
};
