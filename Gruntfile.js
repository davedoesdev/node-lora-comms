"use strict";

module.exports = function (grunt)
{
    grunt.initConfig(
    {
        exec: {
            build: {
                cmd: 'node-gyp build --debug'
            }
        },

        eslint: {
            target: [ 'Gruntfile.js', 'lib/**/*.js', 'test/**/*.js' ]
        },

        mochaTest: {
            src: 'test/test.js'
        }
    });

    grunt.loadNpmTasks('grunt-exec');
    grunt.loadNpmTasks('grunt-eslint');
    grunt.loadNpmTasks('grunt-mocha-test');

    grunt.registerTask('build', 'exec:build');
    grunt.registerTask('lint', 'eslint');
    grunt.registerTask('test', 'mochaTest');
};
